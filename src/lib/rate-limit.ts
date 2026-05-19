import { rateLimit, type Options } from 'express-rate-limit';
import { sendError } from './errors';
import { hasOverride } from './override';

/**
 * Per-IP HTTP rate limiting. Sits in front of (or per-route on top of) the
 * worker's anti-ban send pacing — this layer is the contract the worker
 * advertises to callers ("you may call me at most N times per window"),
 * separate from the messaging-layer pacing that protects the linked phone.
 *
 * Headers: draft-7 `RateLimit-*` (Limit, Remaining, Reset) are set on every
 * response; `Retry-After` is set on 429s. The 429 body uses the standard
 * error envelope so clients have a single error shape to parse.
 *
 * Keying: today there's one shared `X-Worker-Secret`, so per-IP is effectively
 * "per caller". When TODO §1's HMAC + service tokens land, swap the
 * keyGenerator to `req.tokenId` (or similar).
 *
 * `skip`: probes and the docs UI bypass the bucket — they're not part of the
 * API contract and would otherwise dominate the counter.
 */

const COMMON: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Probes / docs aren't part of the API contract — never let them count.
  skip: (req) =>
    req.path === '/health' ||
    req.path === '/health/ready' ||
    req.path === '/metrics' ||
    req.path === '/docs' ||
    req.path.startsWith('/docs/') ||
    req.path === '/dashboard' ||
    req.path.startsWith('/dashboard/') ||
    req.path === '/events' ||
    req.path === '/favicon.ico' ||
    req.path === '/favicon.svg',
};

function envelopeHandler(message: string) {
  return ((req, res, _next, options) => {
    // express-rate-limit v8 always sets Retry-After when the request is
    // blocked; we surface the same value in the body for clients that only
    // parse JSON.
    const resetMs = (req as unknown as { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime?.getTime() ?? Date.now() + options.windowMs;
    const retryAfter = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
    sendError(req, res, 429, 'RATE_LIMITED', message, { retryAfter });
  }) satisfies Options['handler'];
}

/**
 * Global limiter — applied before auth so unauthenticated floods are
 * throttled too. Generous cap; a well-behaved caller's cron should not see this in normal use.
 */
export const globalLimiter = rateLimit({
  ...COMMON,
  windowMs: 60_000,
  limit: 600,
  handler: envelopeHandler('Too many requests — slow down'),
});

/**
 * Send-specific limiter — tighter cap matching the anti-ban jitter floor
 * (5–15 s between sends ⇒ ~4–12 sends/min realistic; 30/min leaves headroom
 * for bulk batches whose 202 returns immediately).
 */
export const sendLimiter = rateLimit({
  ...COMMON,
  windowMs: 60_000,
  limit: 30,
  // Operator override (`X-Worker-Override: 1`) bypasses the send-bucket.
  // High ban risk — explicitly opted into and logged loudly downstream.
  skip: (req, res) => Boolean(COMMON.skip && COMMON.skip(req, res)) || hasOverride(req),
  handler: envelopeHandler('Send rate limit exceeded — pace your sends'),
});
