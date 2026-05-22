import crypto from 'node:crypto';
import { Router } from 'express';
import { sendMessage, checkLive, reinitializeSessionDebounced } from '../sessions';
import { isQuietHour, sleepJitter, getQuietHoursMessage } from '../anti-ban';
import { quietHoursGuard } from '../middleware/quiet-hours';
import { messagesSent, messagesFailed, bulkBatchesStarted } from '../metrics';
import { SendMessageBodySchema, SendBulkBodySchema } from '../openapi';
import { logger } from '../logger';
import { sendError } from '../lib/errors';
import { idempotency } from '../lib/idempotency';
import { sendLimiter } from '../lib/rate-limit';
import { prisma } from '../prisma';
import { eventBus } from '../events';
import { hasOverride } from '../lib/override';

const router = Router();

// ---------------------------------------------------------------------------
// Single send
// ---------------------------------------------------------------------------

router.post('/send', quietHoursGuard, sendLimiter, idempotency, async (req, res) => {
  const parsed = SendMessageBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'BAD_REQUEST', 'Invalid request body', {
      details: parsed.error.issues,
    });
    return;
  }
  const { sessionId, recipient, body } = parsed.data;
  // Header (operator/curl) OR body field — either turns on the bypass.
  const override = hasOverride(req);
  if (override) {
    req.log.warn({ sessionId, recipient }, 'OVERRIDE — send bypassing all anti-ban gates');
  }

  try {
    // Jitter is part of the human-pacing anti-ban posture; skipped under
    // override along with the other gates.
    if (!override) await sleepJitter();
    const result = await sendMessage(sessionId, recipient, body, { override });
    if (result.success) {
      messagesSent.inc({ type: 'single' });
      eventBus.publish('message.sent', {
        sessionId, recipient: result.recipientPhone, messageId: result.messageId, body, override,
      });
      res.json({
        messageId: result.messageId,
        recipientPhone: result.recipientPhone,
        timestamp: result.timestamp,
      });
    } else if (result.rateLimit) {
      messagesFailed.inc({ type: 'single', reason: result.rateLimit.code.toLowerCase() });
      eventBus.publish('message.failed', {
        sessionId, recipient: result.recipientPhone, reason: result.rateLimit.code, body, override,
      });
      sendError(req, res, 429, result.rateLimit.code, result.error ?? 'Rate limited', {
        retryAfter: result.rateLimit.retryAfter,
      });
    } else if (result.sessionUnhealthy) {
      messagesFailed.inc({ type: 'single', reason: 'session_unhealthy' });
      eventBus.publish('message.failed', {
        sessionId, recipient: result.recipientPhone, reason: 'SESSION_UNHEALTHY', body, override,
      });
      sendError(req, res, 503, 'SESSION_UNHEALTHY', result.error ?? 'Session unhealthy', {
        retryAfter: result.sessionUnhealthy.retryAfter,
        details: { state: result.sessionUnhealthy.state },
      });
    } else {
      messagesFailed.inc({ type: 'single', reason: 'send_error' });
      eventBus.publish('message.failed', {
        sessionId, recipient: result.recipientPhone, reason: result.error ?? 'unknown', body, override,
      });
      sendError(req, res, 502, 'SEND_FAILED', result.error ?? 'Send failed', {
        details: { recipientPhone: result.recipientPhone, timestamp: result.timestamp },
      });
    }
  } catch (err) {
    messagesFailed.inc({ type: 'single', reason: 'exception' });
    req.log.error({ err, sessionId }, 'POST /messages/send failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to send message');
  }
});

// ---------------------------------------------------------------------------
// Bulk send — persisted to whatsapp_bulk_batches so progress survives restart
// ---------------------------------------------------------------------------

interface BulkMessageResult {
  index: number;
  recipient: string;
  success: boolean;
  messageId: string | null;
  error?: string;
  timestamp: string;
}

// Atomic JSONB append + counter bump. Doing this in a single UPDATE means a
// concurrent GET poll never sees a half-written results array. The send loop
// is the only writer to a given row, so no lock contention.
async function recordBatchResult(
  batchId: string,
  result: BulkMessageResult,
  succeededDelta: number,
  failedDelta: number,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE whatsapp_bulk_batches
    SET results   = results || ${JSON.stringify([result])}::jsonb,
        succeeded = succeeded + ${succeededDelta},
        failed    = failed    + ${failedDelta}
    WHERE "batchId" = ${batchId}::uuid
  `;
}

router.post('/send-bulk', quietHoursGuard, sendLimiter, idempotency, async (req, res) => {
  const parsed = SendBulkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'BAD_REQUEST', 'Invalid request body', {
      details: parsed.error.issues,
    });
    return;
  }
  const { sessionId, messages } = parsed.data;
  const override = hasOverride(req);
  if (override) {
    req.log.warn({ sessionId, count: messages.length }, 'OVERRIDE — bulk send bypassing all anti-ban gates');
  }

  // Upfront session-health check — better to refuse the whole batch with
  // 503 SESSION_UNHEALTHY than to accept 500 messages and bounce on the
  // first one. Per-message liveness still runs inside the loop (catches
  // mid-batch disconnects), but accepting a batch we know can't ship is
  // user-hostile. Kicks the debounced reinit on the way out so the session
  // starts recovering before the caller retries — 15min cooldown protects
  // the linked phone from re-link bursts.
  const live = await checkLive(sessionId);
  if (live !== 'connected') {
    reinitializeSessionDebounced(sessionId);
    req.log.warn({ sessionId, state: live }, 'POST /messages/send-bulk refused — session unhealthy');
    eventBus.publish('message.failed', {
      sessionId, recipient: '(bulk)', reason: 'SESSION_UNHEALTHY',
    });
    sendError(req, res, 503, 'SESSION_UNHEALTHY', 'Session socket is not connected — reinit in progress; retry shortly', {
      retryAfter: 30,
      details: { state: live },
    });
    return;
  }

  bulkBatchesStarted.inc();
  eventBus.publish('bulk.started', { sessionId, total: messages.length, override });

  const batchId = crypto.randomUUID();
  const batchLog = logger.child({ batchId, sessionId });

  try {
    await prisma.whatsAppBulkBatch.create({
      data: {
        batchId,
        sessionId,
        status: 'processing',
        total: messages.length,
        startedAt: new Date(),
      },
    });
  } catch (err) {
    batchLog.error({ err }, 'failed to persist bulk batch row');
    sendError(req, res, 500, 'INTERNAL', 'Failed to create bulk batch');
    return;
  }

  res.status(202).json({ batchId, total: messages.length, status: 'processing' });

  const finaliseBatch = async () => {
    try {
      await prisma.whatsAppBulkBatch.update({
        where: { batchId },
        data: { status: 'complete', completedAt: new Date() },
      });
    } catch (err) {
      batchLog.error({ err }, 'failed to mark bulk batch complete');
    }
  };

  (async () => {
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < messages.length; i++) {
      const { recipient, body } = messages[i]!;

      // Anti-ban gates only apply when override isn't set: jitter, plus the
      // mid-batch quiet-hours check that would otherwise pause delivery.
      if (i > 0 && !override) await sleepJitter();

      if (!override && isQuietHour()) {
        for (let j = i; j < messages.length; j++) {
          const m = messages[j]!;
          await recordBatchResult(batchId, {
            index: j,
            recipient: m.recipient,
            success: false,
            messageId: null,
            error: getQuietHoursMessage(),
            timestamp: new Date().toISOString(),
          }, 0, 1);
          failed++;
          messagesFailed.inc({ type: 'bulk', reason: 'quiet_hours' });
        }
        break;
      }

      const result = await sendMessage(sessionId, recipient, body, { override });
      await recordBatchResult(batchId, {
        index: i,
        recipient,
        success: result.success,
        messageId: result.messageId,
        error: result.error,
        timestamp: result.timestamp,
      }, result.success ? 1 : 0, result.success ? 0 : 1);
      if (result.success) {
        succeeded++;
        messagesSent.inc({ type: 'bulk' });
      } else {
        failed++;
        messagesFailed.inc({
          type: 'bulk',
          reason: result.rateLimit ? result.rateLimit.code.toLowerCase()
            : result.sessionUnhealthy ? 'session_unhealthy'
            : 'send_error',
        });
        // Session went unhealthy mid-batch — abort the rest. Continuing
        // would just emit hundreds more SESSION_UNHEALTHY failures with no
        // chance of success, and reinit is already kicked off. Caller can
        // re-submit the remaining items after the session recovers.
        if (result.sessionUnhealthy) {
          batchLog.warn({ remaining: messages.length - i - 1 }, 'session unhealthy — aborting bulk batch');
          break;
        }
      }
    }

    batchLog.info({ succeeded, failed, total: messages.length }, 'bulk batch complete');
    eventBus.publish('bulk.completed', { batchId, sessionId, succeeded, failed, total: messages.length, override });
    await finaliseBatch();
  })().catch(async (err) => {
    batchLog.error({ err }, 'bulk batch crashed');
    eventBus.publish('bulk.completed', { batchId, sessionId, crashed: true, error: err instanceof Error ? err.message : String(err), override });
    await finaliseBatch();
  });
});

router.get('/send-bulk/:batchId', async (req, res) => {
  try {
    const batch = await prisma.whatsAppBulkBatch.findUnique({
      where: { batchId: req.params.batchId },
    });
    if (!batch) {
      sendError(req, res, 404, 'NOT_FOUND', 'Batch not found');
      return;
    }
    res.json({
      batchId: batch.batchId,
      sessionId: batch.sessionId,
      status: batch.status,
      total: batch.total,
      succeeded: batch.succeeded,
      failed: batch.failed,
      results: batch.results,
      startedAt: batch.startedAt.toISOString(),
      completedAt: batch.completedAt?.toISOString() ?? undefined,
    });
  } catch (err) {
    req.log.error({ err, batchId: req.params.batchId }, 'GET /messages/send-bulk/:batchId failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to read batch');
  }
});

export default router;
