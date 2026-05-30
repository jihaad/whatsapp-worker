import { prisma } from '../prisma';

/**
 * Messaging-layer anti-ban rate limits — applied inside `sendMessage()` so
 * both `/v1/messages/send` and the bulk loop are covered with one check.
 *
 * Three independent gates, evaluated in order:
 *   1. Per-recipient cooldown — refuse repeat sends to the same number
 *      within 5 minutes. Stops the classic "cron retried, recipient got two
 *      reminders" foot-gun.
 *   2. Per-account per-minute token bucket — caps each linked phone at
 *      30 msg/min, ramped lower during the first 7 days (warmup curve).
 *   3. Global per-minute token bucket — across ALL linked accounts, cap
 *      100 msg/min so one runaway caller can't burn every linked account.
 *
 * Distinct from the HTTP-layer per-IP limiter in `src/lib/rate-limit.ts`:
 * that one protects the worker process from runaway clients; this one
 * protects the linked phone number from a Meta ban.
 *
 * All rejections carry a `code` + `retryAfter` (seconds) and surface as
 * 429 + the standard error envelope at the HTTP boundary.
 *
 * Per-account per-day quota is intentionally NOT shipped — per the latest
 * scope decision, the caller's own queue/log idempotency plus the
 * per-minute limit are deemed sufficient for the current volume.
 */

export type LimitCode =
  | 'RECIPIENT_COOLDOWN'
  | 'ACCOUNT_RATE_LIMIT'
  | 'WARMUP_LIMIT'
  | 'GLOBAL_RATE_LIMIT'
  | 'ACCOUNT_SPACING';

export interface LimitCheckOk { ok: true }
export interface LimitCheckFail { ok: false; code: LimitCode; retryAfter: number; message: string }
export type LimitCheck = LimitCheckOk | LimitCheckFail;

// ---------------------------------------------------------------------------
// 1. Per-recipient cooldown
// ---------------------------------------------------------------------------

const RECIPIENT_COOLDOWN_MS = 5 * 60 * 1000;
const RECIPIENT_LRU_MAX = 10_000;

// Map preserves insertion order; oldest key is .keys().next().value. That
// gives us a simple FIFO eviction — not strict LRU, but good enough for
// 10k entries that turn over every 5 minutes anyway.
const recipientLastSent = new Map<string, number>();

export function checkRecipientCooldown(recipient: string): LimitCheck {
  const last = recipientLastSent.get(recipient);
  if (last === undefined) return { ok: true };
  const elapsed = Date.now() - last;
  if (elapsed >= RECIPIENT_COOLDOWN_MS) return { ok: true };
  return {
    ok: false,
    code: 'RECIPIENT_COOLDOWN',
    retryAfter: Math.ceil((RECIPIENT_COOLDOWN_MS - elapsed) / 1000),
    message: 'Recipient was messaged within the last 5 minutes',
  };
}

export function recordRecipientSend(recipient: string): void {
  recipientLastSent.delete(recipient); // re-insert to move to end (LRU touch)
  recipientLastSent.set(recipient, Date.now());
  while (recipientLastSent.size > RECIPIENT_LRU_MAX) {
    const oldest = recipientLastSent.keys().next().value;
    if (oldest === undefined) break;
    recipientLastSent.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// 2. + 3. Token buckets — per-account (with warmup) and global
// ---------------------------------------------------------------------------

const ACCOUNT_RATE_PER_MIN = 30;
const GLOBAL_RATE_PER_MIN = 100;
const WINDOW_MS = 60_000;

interface Bucket { tokens: number; lastRefill: number; capacity: number }

const accountBuckets = new Map<string, Bucket>();
const globalBucket: Bucket = { tokens: GLOBAL_RATE_PER_MIN, lastRefill: Date.now(), capacity: GLOBAL_RATE_PER_MIN };

function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  if (elapsed <= 0) return;
  const rate = b.capacity / WINDOW_MS; // tokens / ms
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * rate);
  b.lastRefill = now;
}

function tryConsume(b: Bucket): boolean {
  refill(b);
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}

function secondsUntilToken(b: Bucket): number {
  refill(b);
  if (b.tokens >= 1) return 0;
  const rate = b.capacity / WINDOW_MS;
  return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
}

// Warmup curve — fresh accounts get a lower per-minute cap that ramps up
// over the first week. Re-anchored from the daily-quota curve in TODO §2 to
// the per-minute axis since daily quotas are intentionally not shipped.
const WARMUP_CURVE: readonly number[] = [
  /* day 1 */ 5,
  /* day 2 */ 8,
  /* day 3 */ 12,
  /* day 4 */ 18,
  /* day 5 */ 22,
  /* day 6 */ 26,
  /* day 7+ */ 30,
];

// Cache linkedAt per session — it never changes for a given account so one
// DB hit per session per process lifetime is fine.
const linkedAtCache = new Map<string, Date | null>();

async function getAccountCapacity(sessionId: string): Promise<{ capacity: number; isWarmup: boolean }> {
  let linkedAt = linkedAtCache.get(sessionId);
  if (linkedAt === undefined) {
    const row = await prisma.whatsAppSession.findUnique({
      where: { sessionId: sessionId },
      select: { linkedAt: true },
    });
    linkedAt = row?.linkedAt ?? null;
    linkedAtCache.set(sessionId, linkedAt);
  }
  if (!linkedAt) return { capacity: ACCOUNT_RATE_PER_MIN, isWarmup: false };

  const daysSinceLink = Math.floor((Date.now() - linkedAt.getTime()) / (24 * 60 * 60 * 1000));
  if (daysSinceLink >= WARMUP_CURVE.length - 1) {
    return { capacity: ACCOUNT_RATE_PER_MIN, isWarmup: false };
  }
  return { capacity: WARMUP_CURVE[daysSinceLink]!, isWarmup: true };
}

/**
 * Try to consume one token from both the account bucket and the global
 * bucket. Atomic: if the global bucket is empty we refund the account
 * token so the caller can retry without double-charging.
 */
export async function consumeRateTokens(sessionId: string): Promise<LimitCheck> {
  const { capacity, isWarmup } = await getAccountCapacity(sessionId);

  let bucket = accountBuckets.get(sessionId);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: Date.now(), capacity };
    accountBuckets.set(sessionId, bucket);
  } else if (bucket.capacity !== capacity) {
    // Warmup curve ticked over to a higher cap — bump capacity, refill
    // proportionally so we don't punish the account for the increase.
    bucket.tokens = Math.min(capacity, bucket.tokens + (capacity - bucket.capacity));
    bucket.capacity = capacity;
  }

  if (!tryConsume(bucket)) {
    return {
      ok: false,
      code: isWarmup ? 'WARMUP_LIMIT' : 'ACCOUNT_RATE_LIMIT',
      retryAfter: secondsUntilToken(bucket),
      message: isWarmup
        ? `Account is warming up — current cap ${capacity}/min`
        : `Account rate limit reached (${capacity}/min)`,
    };
  }

  if (!tryConsume(globalBucket)) {
    // Refund the account token — we didn't actually send.
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
    return {
      ok: false,
      code: 'GLOBAL_RATE_LIMIT',
      retryAfter: secondsUntilToken(globalBucket),
      message: `Global rate limit reached (${GLOBAL_RATE_PER_MIN}/min across all accounts)`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. Per-account min inter-send spacing
// ---------------------------------------------------------------------------
//
// The token bucket caps *rate* but allows bursts — 30 tokens can fire in a
// few seconds, which reads as automation to WhatsApp's spam scorer (fixed or
// sub-second intervals are a known ban trigger). This gate enforces a
// randomised minimum gap between consecutive sends on the SAME account:
// 15–45s once mature, 30–60s during warmup. Randomised so the cadence isn't
// a tell. Single sends that arrive too soon get rejected with retryAfter (the
// caller paces); the bulk loop instead WAITS out the gap (see
// accountSpacingWaitMs) so it never generates spacing failures.

const SPACING_MIN_MS = Number(process.env.SEND_SPACING_MIN_MS) || 15_000;
const SPACING_MAX_MS = Number(process.env.SEND_SPACING_MAX_MS) || 45_000;
const SPACING_WARMUP_MIN_MS = Number(process.env.SEND_SPACING_WARMUP_MIN_MS) || 30_000;
const SPACING_WARMUP_MAX_MS = Number(process.env.SEND_SPACING_WARMUP_MAX_MS) || 60_000;

// Earliest ms-timestamp at which the next send on a given account is allowed.
const accountNextSend = new Map<string, number>();

/** ms the caller must wait before the next send on this account (0 if clear). */
export function accountSpacingWaitMs(sessionId: string): number {
  const next = accountNextSend.get(sessionId);
  if (next === undefined) return 0;
  return Math.max(0, next - Date.now());
}

/**
 * Reject-gate form of the spacing check — for the single-send path, where
 * blocking the HTTP request for up to a minute is undesirable. Returns a
 * retryAfter so the caller can pace.
 */
export function checkAccountSpacing(sessionId: string): LimitCheck {
  const wait = accountSpacingWaitMs(sessionId);
  if (wait <= 0) return { ok: true };
  const retryAfter = Math.ceil(wait / 1000);
  return {
    ok: false,
    code: 'ACCOUNT_SPACING',
    retryAfter,
    message: `Minimum spacing between sends on this account — retry in ~${retryAfter}s`,
  };
}

/**
 * Record a send and arm the next-allowed timestamp with a fresh randomised
 * gap (warmup-aware). Call on every successful send. `isWarmup` is resolved
 * from the (cached) linkedAt so callers don't have to thread it through.
 */
export async function recordAccountSend(sessionId: string): Promise<void> {
  const { isWarmup } = await getAccountCapacity(sessionId);
  const [min, max] = isWarmup
    ? [SPACING_WARMUP_MIN_MS, SPACING_WARMUP_MAX_MS]
    : [SPACING_MIN_MS, SPACING_MAX_MS];
  const gap = min + Math.floor(Math.random() * (max - min + 1));
  accountNextSend.set(sessionId, Date.now() + gap);
}

/**
 * Invalidate the cached linkedAt for a session — call on destroySession()
 * so a re-link picks up the new (fresh) linkedAt + restarts the warmup
 * curve from day 1.
 */
export function forgetAccount(sessionId: string): void {
  linkedAtCache.delete(sessionId);
  accountBuckets.delete(sessionId);
  accountNextSend.delete(sessionId);
}

// Body-text variation lives in src/lib/body-variation.ts — separated so the
// rate-limit module stays focused on counting tokens, not mutating payloads.
