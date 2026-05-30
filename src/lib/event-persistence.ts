import { prisma } from '../prisma';
import { logger } from '../logger';
import { eventBus, type WorkerEvent } from '../events';

/**
 * Persist message + bulk events to `whatsapp_message_events` so the dashboard
 * can show history across worker restarts and dashboard reloads.
 *
 * Subscribed to `eventBus.on('event', …)` and writes fire-and-forget — a
 * single failed insert must NOT break the send path. Each error is logged
 * once at error level and swallowed.
 *
 * Session-lifecycle events (`session.*`) are intentionally NOT persisted —
 * they're operational noise; pino logs cover audit. Only `message.*` and
 * `bulk.*` get a row.
 *
 * 7-day retention. Eviction sweep runs hourly via `unref()`'d timer so it
 * doesn't block shutdown.
 */

const log = logger.child({ component: 'event-persistence' });

const PERSISTED_TYPES = new Set([
  'message.sent',
  'message.failed',
  'message.ack',
  'bulk.started',
  'bulk.completed',
]);

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let evictionTimer: NodeJS.Timeout | null = null;
let listener: ((ev: WorkerEvent) => void) | null = null;

function persist(event: WorkerEvent): void {
  if (!PERSISTED_TYPES.has(event.type)) return;
  const d = event.data ?? {};
  prisma.whatsAppMessageEvent
    .create({
      data: {
        ts: new Date(event.ts),
        type: event.type,
        sessionId: typeof d.sessionId === 'string' ? d.sessionId : null,
        recipient: typeof d.recipient === 'string' ? d.recipient : null,
        messageId: typeof d.messageId === 'string' ? d.messageId : null,
        batchId:   typeof d.batchId   === 'string' ? d.batchId   : null,
        ack:       typeof d.ack       === 'number' ? d.ack       : null,
        error:
          typeof d.reason === 'string' ? d.reason :
          typeof d.error === 'string'  ? d.error  : null,
        data: d as object,
      },
    })
    .catch((err) => {
      // One bad insert must never break a send. Log and move on.
      log.error({ err, type: event.type }, 'failed to persist event');
    });
}

async function evictOld(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const result = await prisma.whatsAppMessageEvent.deleteMany({
      where: { ts: { lt: cutoff } },
    });
    if (result.count > 0) {
      log.info({ count: result.count }, 'evicted message events older than 7d');
    }
  } catch (err) {
    log.error({ err }, 'event eviction sweep failed');
  }
}

export function startEventPersistence(): void {
  if (listener) return; // idempotent
  listener = (event: WorkerEvent) => persist(event);
  eventBus.on('event', listener);
  // First sweep on boot, then hourly.
  void evictOld();
  evictionTimer = setInterval(evictOld, SWEEP_INTERVAL_MS);
  evictionTimer.unref();
}

export function stopEventPersistence(): void {
  if (listener) {
    eventBus.off('event', listener);
    listener = null;
  }
  if (evictionTimer) {
    clearInterval(evictionTimer);
    evictionTimer = null;
  }
}
