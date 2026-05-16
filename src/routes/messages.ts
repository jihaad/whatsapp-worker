import crypto from 'node:crypto';
import { Router } from 'express';
import { sendMessage } from '../sessions';
import { isQuietHour, sleepJitter, QUIET_HOURS_MESSAGE } from '../anti-ban';
import { quietHoursGuard } from '../middleware/quiet-hours';
import { messagesSent, messagesFailed, bulkBatchesStarted } from '../metrics';
import { SendMessageBodySchema, SendBulkBodySchema } from '../openapi';
import { logger } from '../logger';
import { sendError } from '../lib/errors';
import { idempotency } from '../lib/idempotency';
import { sendLimiter } from '../lib/rate-limit';
import { prisma } from '../prisma';
import { eventBus } from '../events';

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

  try {
    await sleepJitter();
    const result = await sendMessage(sessionId, recipient, body);
    if (result.success) {
      messagesSent.inc({ type: 'single' });
      eventBus.publish('message.sent', {
        sessionId, recipient: result.recipientPhone, messageId: result.messageId,
      });
      res.json({
        messageId: result.messageId,
        recipientPhone: result.recipientPhone,
        timestamp: result.timestamp,
      });
    } else if (result.rateLimit) {
      messagesFailed.inc({ type: 'single', reason: result.rateLimit.code.toLowerCase() });
      eventBus.publish('message.failed', {
        sessionId, recipient: result.recipientPhone, reason: result.rateLimit.code,
      });
      sendError(req, res, 429, result.rateLimit.code, result.error ?? 'Rate limited', {
        retryAfter: result.rateLimit.retryAfter,
      });
    } else {
      messagesFailed.inc({ type: 'single', reason: 'send_error' });
      eventBus.publish('message.failed', {
        sessionId, recipient: result.recipientPhone, reason: result.error ?? 'unknown',
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

  bulkBatchesStarted.inc();
  eventBus.publish('bulk.started', { sessionId, total: messages.length });

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

      if (i > 0) await sleepJitter();

      if (isQuietHour()) {
        for (let j = i; j < messages.length; j++) {
          const m = messages[j]!;
          await recordBatchResult(batchId, {
            index: j,
            recipient: m.recipient,
            success: false,
            messageId: null,
            error: QUIET_HOURS_MESSAGE,
            timestamp: new Date().toISOString(),
          }, 0, 1);
          failed++;
          messagesFailed.inc({ type: 'bulk', reason: 'quiet_hours' });
        }
        break;
      }

      const result = await sendMessage(sessionId, recipient, body);
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
          reason: result.rateLimit ? result.rateLimit.code.toLowerCase() : 'send_error',
        });
      }
    }

    batchLog.info({ succeeded, failed, total: messages.length }, 'bulk batch complete');
    eventBus.publish('bulk.completed', { batchId, sessionId, succeeded, failed, total: messages.length });
    await finaliseBatch();
  })().catch(async (err) => {
    batchLog.error({ err }, 'bulk batch crashed');
    eventBus.publish('bulk.completed', { batchId, sessionId, crashed: true, error: err instanceof Error ? err.message : String(err) });
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
