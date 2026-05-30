import { runWatchdogSweep } from '../sessions';
import { logger } from '../logger';

const log = logger.child({ component: 'session-watchdog' });

/**
 * Periodic session-recovery sweep. See runWatchdogSweep() in sessions.ts for
 * the passes; in short, every WATCHDOG_INTERVAL_MS it:
 *   1. force-checkLive()s `ready` sessions to catch silent socket deaths,
 *   2. reinits `disconnected` sessions,
 *   3. reinits sessions wedged in `connecting` (+ alerts the operator), and
 *   4. reconciles against the DB — re-inits any saved session that isn't
 *      live in memory, so everything comes back after a restart with no
 *      manual intervention even if the boot-time restore failed.
 *
 * **Ban-safety:** every reinit of an in-memory session goes through
 * `reinitializeSessionDebounced`, hard-capped at one attempt per 15 min per
 * session — WhatsApp ratelimits re-link attempts, and an uncapped reconnect
 * loop would burn the linked phone. The DB-reconcile pass (4) restores from
 * a *valid saved blob* (a session resume, not a fresh QR pairing) and any
 * blob WhatsApp rejects has its DB row deleted on the restore-rejected path,
 * so a rejected session never loops re-auth here.
 *
 * The timer is `unref()`'d so it doesn't keep the event loop alive during
 * shutdown.
 */

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  try {
    await runWatchdogSweep();
  } catch (err) {
    log.error({ err }, 'watchdog sweep failed');
  }
}

export function startSessionWatchdog(): void {
  if (timer) return; // idempotent
  // Don't fire immediately on boot — restoreSessions() is still warming up,
  // and false-positive disconnects during init would be noisy.
  timer = setInterval(sweep, WATCHDOG_INTERVAL_MS);
  timer.unref();
  log.info({ intervalMs: WATCHDOG_INTERVAL_MS }, 'session watchdog started');
}

export function stopSessionWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
