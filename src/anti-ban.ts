/**
 * Anti-ban helpers — applied per-request inside `POST /messages/send`.
 *
 * The worker is pure-API: there's no internal queue. Callers POST one
 * message at a time (or use `/messages/send-bulk` for batched dispatch),
 * and these helpers run inline before whatsapp-web.js sees the request.
 *
 * What they do:
 *
 *   - **Quiet hours** — reject the request with HTTP 503 + `Retry-After`
 *     when local time is outside the configured window (default
 *     07:00–21:00 in `QUIET_HOUR_TZ`). Callers are expected to retry
 *     after the supplied delay.
 *
 *   - **Randomised jitter** — wait 5–15s before invoking whatsapp-web.js's
 *     `sendMessage`, so the gap between consecutive sends has natural
 *     variance. Worst-case throughput ~6 msg/min, well under WhatsApp
 *     Web's safe rate.
 *
 * Both are part of the basic anti-ban posture. The route composes them in
 * order: quiet-hours guard first (fail fast), then await the jitter, then
 * call `sendMessage`.
 *
 * **Quiet-hours config is mutable at runtime.** The dashboard exposes a
 * settings modal that hits PUT /v1/config/quiet-hours, which calls
 * `setQuietHoursConfig` here AND rewrites the on-disk `.env` so the new
 * window survives restarts. `process.env` itself is loaded once on boot
 * by src/prisma.ts via `process.loadEnvFile('.env')` — we don't re-read
 * it; we just mutate this module-local state and rebuild the
 * Intl formatters when the timezone changes.
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

export interface QuietHoursConfig {
  /** Inclusive lower bound of the send window, hour 0–23. */
  start: number;
  /** Exclusive upper bound, hour 1–24. start === 0 && end === 24 means always live. */
  end: number;
  /** IANA timezone (e.g. `Africa/Nairobi`, `Europe/London`). */
  tz: string;
}

const cfg: QuietHoursConfig = {
  start: Number(process.env.QUIET_HOUR_START ?? 7),
  end:   Number(process.env.QUIET_HOUR_END   ?? 21),
  tz:    process.env.QUIET_HOUR_TZ ?? 'Africa/Nairobi',
};

// Lazy-initialised formatters — `Intl.DateTimeFormat` is expensive to
// construct so we cache one of each. Rebuilt whenever the timezone changes.
let eatHourFmt = buildHourFmt(cfg.tz);
let eatPartsFmt = buildPartsFmt(cfg.tz);

function buildHourFmt(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false });
}
function buildPartsFmt(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  });
}

/** Read-only snapshot of the current quiet-hours config. */
export function getQuietHoursConfig(): QuietHoursConfig {
  return { ...cfg };
}

/**
 * Replace the active quiet-hours config in-process. Caller is responsible
 * for persisting to `.env` via writeEnvVars if the change should survive a
 * restart. Throws if the supplied tz isn't a valid IANA zone.
 */
export function setQuietHoursConfig(next: QuietHoursConfig): void {
  if (!Number.isInteger(next.start) || next.start < 0 || next.start > 23) {
    throw new RangeError('start must be an integer 0–23');
  }
  if (!Number.isInteger(next.end) || next.end < 1 || next.end > 24) {
    throw new RangeError('end must be an integer 1–24');
  }
  if (next.end <= next.start) {
    throw new RangeError('end must be greater than start (rollover windows are not supported)');
  }
  // Validate tz by trying to instantiate a formatter; Intl throws on
  // unrecognised zones (e.g. 'Atlantis/Lost').
  try { new Intl.DateTimeFormat('en-GB', { timeZone: next.tz }); }
  catch { throw new RangeError(`Unknown IANA timezone: ${next.tz}`); }

  const tzChanged = next.tz !== cfg.tz;
  cfg.start = next.start;
  cfg.end   = next.end;
  cfg.tz    = next.tz;
  if (tzChanged) {
    eatHourFmt  = buildHourFmt(cfg.tz);
    eatPartsFmt = buildPartsFmt(cfg.tz);
  }
}

const pad = (h: number) => String(h).padStart(2, '0');

/** Reason string used in the 503 envelope and surfaced in the dashboard. */
export function getQuietHoursMessage(): string {
  return `Quiet hours — sends paused outside ${pad(cfg.start)}:00–${pad(cfg.end)}:00 (${cfg.tz})`;
}

/** True when local time in the configured timezone is outside the send window. */
export function isQuietHour(now: Date = new Date()): boolean {
  // start === 0 && end === 24 = always live — short-circuit to avoid
  // formatter cost on every send when quiet hours are effectively disabled.
  if (cfg.start === 0 && cfg.end === 24) return false;
  const hour = parseInt(eatHourFmt.format(now), 10);
  return hour < cfg.start || hour >= cfg.end;
}

/**
 * Seconds until the next start-of-window in the configured timezone,
 * suitable for an HTTP `Retry-After` header. Caps at 24h to keep the
 * value sane on clock drift.
 */
export function secondsUntilNextSendWindow(now: Date = new Date()): number {
  const parts = eatPartsFmt.formatToParts(now);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  const nowSec = hour * 3600 + minute * 60 + second;
  const startSec = cfg.start * 3600;
  const dayLen = 24 * 3600;

  // Currently before start → wait until start today.
  // Currently >= end       → wait until start tomorrow.
  const remaining = nowSec < startSec
    ? startSec - nowSec
    : (dayLen - nowSec) + startSec;

  return Math.min(remaining, dayLen);
}
