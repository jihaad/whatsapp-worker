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

export const QUIET_HOUR_START = Number(process.env.QUIET_HOUR_START ?? 7);
export const QUIET_HOUR_END   = Number(process.env.QUIET_HOUR_END   ?? 21);
export const QUIET_HOUR_TZ    = process.env.QUIET_HOUR_TZ ?? 'Africa/Nairobi';

const pad = (h: number) => String(h).padStart(2, '0');
export const QUIET_HOURS_MESSAGE =
  `Quiet hours — sends paused outside ${pad(QUIET_HOUR_START)}:00–${pad(QUIET_HOUR_END)}:00 (${QUIET_HOUR_TZ})`;

// Reuse a single formatter instance — Intl.DateTimeFormat construction is
// expensive and these are called on every send request.
const eatHourFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: QUIET_HOUR_TZ, hour: 'numeric', hour12: false,
});
const eatPartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: QUIET_HOUR_TZ,
  hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
});

/** True when local time in the configured timezone is outside the send window. */
export function isQuietHour(now: Date = new Date()): boolean {
  // `Intl` with explicit IANA TZ — works regardless of the host's system clock.
  const hh = eatHourFmt.format(now);
  const hour = parseInt(hh, 10);
  return hour < QUIET_HOUR_START || hour >= QUIET_HOUR_END;
}

/**
 * Seconds until the next 07:00 EAT, suitable for an HTTP `Retry-After`
 * header when rejecting a send during quiet hours. Caps at 24h to keep
 * the value sane on clock drift.
 */
export function secondsUntilNextSendWindow(now: Date = new Date()): number {
  const eatNow = eatPartsFmt.formatToParts(now);
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
