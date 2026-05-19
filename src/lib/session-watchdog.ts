import { runWatchdogSweep } from '../sessions';
import { logger } from '../logger';

const log = logger.child({ component: 'session-watchdog' });

/**
 * Periodic session-liveness sweep.
 *
 * Every WATCHDOG_INTERVAL_MS, walk all in-memory `ready` sessions and call
 * `checkLive()` (forced — bypasses the per-session 5s cache). `checkLive`
 * mutates status to `disconnected` and publishes a `session.disconnected`
 * event when it finds a dead socket; the dashboard reflects that change
 * instantly without polling.
 *
 * **Ban-safety:** this is detect-only. It deliberately does NOT trigger
 * reinit. WhatsApp ratelimits re-link attempts, so a passive timer that
 * auto-reconnects every disconnect (with no caller waiting) would burn the
 * linked phone over time. Reinit happens only when a real send arrives for
 * a dead session — `sendMessage` calls `reinitializeSessionDebounced` which
 * is hard-capped at one attempt per 15 minutes per session.
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
