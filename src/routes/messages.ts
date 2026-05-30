import crypto from 'node:crypto';
import { Router } from 'express';
import { sendMessage, checkLive, reinitializeSessionDebounced } from '../sessions';
import { isQuietHour, sleepJitter, nextMessageDelayMs, getQuietHoursMessage } from '../anti-ban';
import { accountSpacingWaitMs } from '../lib/messaging-limits';
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
import { ackLabel } from '../lib/ack';

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

  // Generate the batchId before announcing the batch so the dashboard can
  // expand a still-processing batch (the bulk.started row carries it too).
  const batchId = crypto.randomUUID();
  const batchLog = logger.child({ batchId, sessionId });

  bulkBatchesStarted.inc();
  eventBus.publish('bulk.started', { sessionId, batchId, total: messages.length, override });

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

      // Anti-ban pacing (skipped under override): wait out the per-account
      // min inter-send spacing (randomised 15–45s mature / 30–60s warming).
      // This subsumes the old fixed jitter and means sendMessage's
      // ACCOUNT_SPACING gate never trips mid-batch. We wait the account's
      // OUTSTANDING window even for the first message (i === 0) — a batch can
      // start right after other activity already armed it, and skipping the
      // wait there would make message 0 fail the gate. Between messages
      // (i > 0) we also enforce a jitter floor so the cadence has variance.
      if (!override) {
        const wait = Math.max(accountSpacingWaitMs(sessionId), i > 0 ? nextMessageDelayMs() : 0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

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

    // Merge live delivery/read acks into each result by messageId. Acks are
    // tracked uniformly for bulk-sent messages (the message_ack handler in
    // sessions.ts), so this surfaces per-recipient delivered/read state in the
    // batch poll — read at query time, so the append-only results JSONB is
    // never mutated (no write race with the send loop).
    const results = (batch.results as unknown as BulkMessageResult[]) ?? [];
    const ids = results.map((r) => r.messageId).filter((x): x is string => !!x);
    const ackMap = new Map<string, number>();
    if (ids.length > 0) {
      const ackRows = await prisma.whatsAppMessageEvent.findMany({
        where: { messageId: { in: ids }, ack: { not: null } },
        select: { messageId: true, ack: true },
      });
      for (const r of ackRows) {
        if (!r.messageId || r.ack == null) continue;
        // Acks can arrive out of order on reconnect — keep the highest.
        ackMap.set(r.messageId, Math.max(ackMap.get(r.messageId) ?? -2, r.ack));
      }
    }
    const enriched = results.map((r) => {
      const ack = r.messageId ? ackMap.get(r.messageId) ?? null : null;
      return {
        ...r,
        ack,
        deliveryStatus: r.success ? ackLabel(ack) : null,
        delivered: ack != null && ack >= 2,
        read: ack != null && ack >= 3,
      };
    });

    res.json({
      batchId: batch.batchId,
      sessionId: batch.sessionId,
      status: batch.status,
      total: batch.total,
      succeeded: batch.succeeded,
      failed: batch.failed,
      results: enriched,
      startedAt: batch.startedAt.toISOString(),
      completedAt: batch.completedAt?.toISOString() ?? undefined,
    });
  } catch (err) {
    req.log.error({ err, batchId: req.params.batchId }, 'GET /messages/send-bulk/:batchId failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to read batch');
  }
});

// Delivery/read status for a single sent message. Acks arrive asynchronously
// (the recipient's device confirms seconds-to-hours later), so this is a poll:
// callers hit it after a send to learn whether the message was delivered
// (ack ≥ 2) or read (ack 3). Works for single and bulk sends alike. SSE
// subscribers (GET /events) also receive the same transitions live as
// `message.ack` events.
//
// Registered after the literal /send-bulk routes; the two-segment shapes
// (`send-bulk/:batchId` vs `:messageId/status`) don't overlap.
router.get('/:messageId/status', async (req, res) => {
  const { messageId } = req.params;
  try {
    const rows = await prisma.whatsAppMessageEvent.findMany({
      where: { messageId },
      orderBy: { ts: 'asc' },
      select: { type: true, ts: true, sessionId: true, recipient: true, ack: true, error: true },
    });
    if (rows.length === 0) {
      sendError(req, res, 404, 'NOT_FOUND', 'Unknown messageId (never sent, or evicted after 7-day retention)');
      return;
    }

    const sent = rows.find((r) => r.type === 'message.sent');
    const failed = rows.find((r) => r.type === 'message.failed');
    // Highest ack seen wins (out-of-order delivery on reconnect is possible).
    const ack = rows.reduce<number | null>(
      (max, r) => (r.ack != null && (max == null || r.ack > max) ? r.ack : max),
      null,
    );
    const last = rows[rows.length - 1]!;

    res.json({
      messageId,
      sessionId: sent?.sessionId ?? rows[0]!.sessionId ?? null,
      recipient: sent?.recipient ?? rows[0]!.recipient ?? null,
      ack, // numeric -1..4, or null if no ack observed yet
      status: failed && !sent ? 'failed' : ackLabel(ack),
      delivered: ack != null && ack >= 2,
      read: ack != null && ack >= 3,
      sentAt: sent?.ts.toISOString() ?? null,
      lastUpdateAt: last.ts.toISOString(),
      error: failed?.error ?? null,
    });
  } catch (err) {
    req.log.error({ err, messageId }, 'GET /messages/:messageId/status failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to read message status');
  }
});

export default router;
