import { prisma } from '../prisma';
import { logger } from '../logger';

const log = logger.child({ component: 'bulk-batch-maintenance' });

/**
 * Boot-time sweep: any row left in `processing` is from a previous process
 * whose send loop is now dead. Transition it to `interrupted` so the GET poll
 * reports an accurate terminal state and the caller can decide whether to requeue.
 *
 * Called once at startup from src/index.ts before HTTP starts accepting new
 * batches, so a fresh batch posted seconds after restart can't be mistaken
 * for one of the dead ones.
 */
export async function markInterruptedBatches(): Promise<void> {
  try {
    const result = await prisma.whatsAppBulkBatch.updateMany({
      where: { status: 'processing' },
      data: { status: 'interrupted', completedAt: new Date() },
    });
    if (result.count > 0) {
      log.warn({ count: result.count }, 'marked stale processing batches as interrupted');
    }
  } catch (err) {
    log.error({ err }, 'mark-interrupted sweep failed');
  }
}

/**
 * Periodic eviction: completed/interrupted batches older than 24 h are
 * deleted. Bulk batches are operational state, not history — long-term audit
 * lives in the calling application's queue / log table. Sweep runs on a 1 h timer; missed ticks
 * (e.g. process restart between sweeps) are caught by the next one.
 */
const EVICTION_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let evictionTimer: NodeJS.Timeout | null = null;

async function evictOldBatches(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - EVICTION_AGE_MS);
    const result = await prisma.whatsAppBulkBatch.deleteMany({
      where: {
        status: { in: ['complete', 'interrupted'] },
        completedAt: { lt: cutoff },
      },
    });
    if (result.count > 0) {
      log.info({ count: result.count }, 'evicted bulk batches older than 24h');
    }
  } catch (err) {
    log.error({ err }, 'eviction sweep failed');
  }
}

export function startBulkBatchEviction(): void {
  // Fire once immediately so a long-lived process doesn't wait an hour for
  // the first cleanup, then on the interval.
  void evictOldBatches();
  evictionTimer = setInterval(evictOldBatches, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive purely for this timer — let SIGTERM
  // shutdown win.
  evictionTimer.unref();
}

export function stopBulkBatchEviction(): void {
  if (evictionTimer) {
    clearInterval(evictionTimer);
    evictionTimer = null;
  }
}
