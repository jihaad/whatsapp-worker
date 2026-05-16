import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { sendError } from './errors';

/**
 * Idempotency-Key middleware (Stripe convention).
 *
 * Clients pass `Idempotency-Key: <opaque-string>` to make POST safe to retry.
 * The middleware caches the first response under that key for 24 h and replays
 * it on subsequent matching requests, so a retry after a timeout cannot
 * trigger a second WhatsApp send.
 *
 * In-memory only — a worker crash loses the window. That's acceptable when
 * the calling application has its own durable safety net (e.g. a unique
 * constraint on its "send this notification once" queue). The worker-side
 * window is the cheap top layer that catches the most common case: a
 * client timing out and retrying within seconds.
 *
 * Rules:
 *   - Key absent          → request runs normally, no caching.
 *   - Key present, fresh  → run handler, cache its response (if non-5xx).
 *   - Key present, cached → replay (status + body), set `Idempotent-Replay: true`.
 *   - Key reused with a different request body → 422 IDEMPOTENCY_KEY_REUSED.
 *   - Key present, another request still in flight → 409 IDEMPOTENT_REQUEST_IN_PROGRESS.
 *
 * 5xx responses are NOT cached so clients can retry server errors.
 */

interface CachedResponse {
  status: number;
  body: unknown;
  contentHash: string;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MIN_KEY_LEN = 8;
const MAX_KEY_LEN = 200;

const cache = new Map<string, CachedResponse>();
const inFlight = new Set<string>();

function hashBody(body: unknown): string {
  // JSON.stringify is non-deterministic for object key order. Clients should
  // emit a stable serialisation; otherwise reordered keys will trip the
  // "reused with different body" check. Documented in OpenAPI.
  return crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export const idempotency: RequestHandler = (req, res, next) => {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) return next();

  if (key.length < MIN_KEY_LEN || key.length > MAX_KEY_LEN) {
    return sendError(req, res, 400, 'BAD_REQUEST', `Idempotency-Key must be ${MIN_KEY_LEN}-${MAX_KEY_LEN} characters`);
  }

  const contentHash = hashBody(req.body);

  const cached = cache.get(key);
  if (cached) {
    if (cached.contentHash !== contentHash) {
      return sendError(req, res, 422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key reused with a different request body');
    }
    res.setHeader('Idempotent-Replay', 'true');
    res.status(cached.status).json(cached.body);
    return;
  }

  if (inFlight.has(key)) {
    return sendError(req, res, 409, 'IDEMPOTENT_REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is already in flight');
  }

  inFlight.add(key);

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    // Cache only non-5xx — 5xx is "we broke", caller may retry.
    if (res.statusCode < 500) {
      cache.set(key, { status: res.statusCode, body, contentHash });
      setTimeout(() => cache.delete(key), TTL_MS);
    }
    inFlight.delete(key);
    return originalJson(body);
  };
  // Belt-and-braces: release the in-flight lock even if the handler throws
  // before res.json fires (Express will close the socket).
  res.on('close', () => inFlight.delete(key));

  next();
};
