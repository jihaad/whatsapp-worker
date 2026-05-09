/**
 * Anti-ban helpers — applied per-request inside `POST /messages/send`.
 *
 * Inherited from the old queue-drain loop in `dispatch.ts` (FD-side, since
 * removed). The worker is now pure-API: there's no internal queue, FD's
 * cron POSTs each due reminder one at a time. These helpers run inline.
 *
 * What they do:
 *
 *   - **Quiet hours** — reject the request with HTTP 503 + `Retry-After`
 *     when local time is outside 07:00–21:00 EAT. FD's cron is expected
 *     to retry on the next tick.
 *
 *   - **Randomised jitter** — wait 5–15s before invoking whatsapp-web.js's
 *     `sendMessage`, so the gap between consecutive sends from FD's cron
 *     loop has natural variance. Worst-case throughput ~6 msg/min, well
 *     under WhatsApp Web's safe rate.
 *
 * Both are part of WAHA's basic anti-ban posture. Caller composes them in
 * order: quiet-hours guard first (fail fast), then await the jitter, then
 * call `sendMessage`.
 */

// --- Jitter --------------------------------------------------------------

const PER_MESSAGE_DELAY_MIN_MS = 5_000;
const PER_MESSAGE_DELAY_MAX_MS = 15_000;

/** Uniform random delay in [PER_MESSAGE_DELAY_MIN_MS, PER_MESSAGE_DELAY_MAX_MS]. */
export function nextMessageDelayMs(): number {
  return Math.random() * (PER_MESSAGE_DELAY_MAX_MS - PER_MESSAGE_DELAY_MIN_MS) + PER_MESSAGE_DELAY_MIN_MS;
}

/** Sleep for one jittered window. Awaitable from the send endpoint. */
export function sleepJitter(): Promise<void> {
  return new Promise((r) => setTimeout(r, nextMessageDelayMs()));
}

// --- Quiet hours ---------------------------------------------------------

const QUIET_HOUR_START = 7;  // inclusive: first hour we send (07:00 EAT)
const QUIET_HOUR_END = 21;   // exclusive: first hour we stop  (21:00 EAT)

/** True when local time in `Africa/Nairobi` is outside the send window. */
export function isQuietHour(now: Date = new Date()): boolean {
  // `Intl` with explicit IANA TZ — works regardless of the host's system clock.
  const hh = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', hour: 'numeric', hour12: false,
  }).format(now);
  const hour = parseInt(hh, 10);
  return hour < QUIET_HOUR_START || hour >= QUIET_HOUR_END;
}

/**
 * Seconds until the next 07:00 EAT, suitable for an HTTP `Retry-After`
 * header when rejecting a send during quiet hours. Caps at 24h to keep
 * the value sane on clock drift.
 */
export function secondsUntilNextSendWindow(now: Date = new Date()): number {
  const eatNow = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parseInt(eatNow.find((p) => p.type === type)?.value ?? '0', 10);
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  const nowSec = hour * 3600 + minute * 60 + second;
  const startSec = QUIET_HOUR_START * 3600;
  const dayLen = 24 * 3600;

  // Currently before 07:00 → wait until 07:00 today.
  // Currently >= 21:00     → wait until 07:00 tomorrow.
  const remaining = nowSec < startSec
    ? startSec - nowSec
    : (dayLen - nowSec) + startSec;

  return Math.min(remaining, dayLen);
}
