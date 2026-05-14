import crypto from 'node:crypto';
import { Router } from 'express';
import { sendMessage } from '../sessions';
import { isQuietHour, sleepJitter, QUIET_HOURS_MESSAGE } from '../anti-ban';
import { quietHoursGuard } from '../middleware/quiet-hours';
import { messagesSent, messagesFailed, bulkBatchesStarted } from '../metrics';
import { SendMessageBodySchema, SendBulkBodySchema } from '../openapi';

const router = Router();

// ---------------------------------------------------------------------------
// Single send
// ---------------------------------------------------------------------------

router.post('/send', quietHoursGuard, async (req, res) => {
  const parsed = SendMessageBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    return;
  }
  const { sessionId, recipient, body } = parsed.data;

  try {
    await sleepJitter();
    const result = await sendMessage(sessionId, recipient, body);
    if (result.success) messagesSent.inc({ type: 'single' });
    else messagesFailed.inc({ type: 'single', reason: 'send_error' });
    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    messagesFailed.inc({ type: 'single', reason: 'exception' });
    console.error(`[worker] POST /messages/send for ${sessionId} → ${recipient}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send message' });
  }
});

// ---------------------------------------------------------------------------
// Bulk send — in-memory batch progress store
// ---------------------------------------------------------------------------

interface BulkMessageResult {
  index: number;
  recipient: string;
  success: boolean;
  messageId: string | null;
  error?: string;
  timestamp: string;
}

interface BulkBatch {
  batchId: string;
  sessionId: string;
  status: 'processing' | 'complete';
  total: number;
  succeeded: number;
  failed: number;
  results: BulkMessageResult[];
  startedAt: string;
  completedAt?: string;
}

const bulkBatches = new Map<string, BulkBatch>();

router.post('/send-bulk', quietHoursGuard, async (req, res) => {
  const parsed = SendBulkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    return;
  }
  const { sessionId, messages } = parsed.data;

  bulkBatchesStarted.inc();

  const batchId = crypto.randomUUID();
  const batch: BulkBatch = {
    batchId, sessionId,
    status: 'processing',
    total: messages.length,
    succeeded: 0, failed: 0,
    results: [],
    startedAt: new Date().toISOString(),
  };
  bulkBatches.set(batchId, batch);

  res.status(202).json({ batchId, total: messages.length, status: 'processing' });

  const finaliseBatch = () => {
    batch.status = 'complete';
    batch.completedAt = new Date().toISOString();
    // Evict after 24 h to prevent unbounded memory growth.
    setTimeout(() => bulkBatches.delete(batchId), 24 * 60 * 60 * 1000);
  };

  (async () => {
    for (let i = 0; i < messages.length; i++) {
      const { recipient, body } = messages[i]!;

      if (i > 0) await sleepJitter();

      if (isQuietHour()) {
        for (let j = i; j < messages.length; j++) {
          const m = messages[j]!;
          batch.results.push({ index: j, recipient: m.recipient, success: false, messageId: null, error: QUIET_HOURS_MESSAGE, timestamp: new Date().toISOString() });
          batch.failed++;
          messagesFailed.inc({ type: 'bulk', reason: 'quiet_hours' });
        }
        break;
      }

      const result = await sendMessage(sessionId, recipient, body);
      batch.results.push({ index: i, recipient, success: result.success, messageId: result.messageId, error: result.error, timestamp: result.timestamp });
      if (result.success) {
        batch.succeeded++;
        messagesSent.inc({ type: 'bulk' });
      } else {
        batch.failed++;
        messagesFailed.inc({ type: 'bulk', reason: 'send_error' });
      }
    }

    console.log(`[worker] bulk batch ${batchId}: ${batch.succeeded}/${batch.total} sent`);
    finaliseBatch();
  })().catch((err) => {
    console.error(`[worker] bulk batch ${batchId} crashed:`, err);
    finaliseBatch();
  });
});

router.get('/send-bulk/:batchId', (req, res) => {
  const batch = bulkBatches.get(req.params.batchId);
  if (!batch) {
    res.status(404).json({ error: 'Batch not found' });
    return;
  }
  res.json(batch);
});

export default router;
