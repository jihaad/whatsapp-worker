import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../logger';
import { sendError } from '../lib/errors';

const RAW_SECRET = process.env.WHATSAPP_WORKER_SECRET;

if (!RAW_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('WHATSAPP_WORKER_SECRET is not set — refusing to start in production');
    process.exit(1);
  }
  logger.warn('WHATSAPP_WORKER_SECRET is not set — running with insecure default');
}

const SECRET_BUF = Buffer.from(RAW_SECRET ?? 'dev-worker-secret');
const PUBLIC_PATHS = new Set(['/health', '/health/ready', '/docs', '/metrics', '/dashboard']);
// Scalar mounts at /docs and serves the spec at /docs/openapi.json. The
// dashboard at /dashboard serves an HTML shell publicly — its JS prompts the
// operator for the worker secret and includes it on every API call (including
// /events). Both subtrees need to be reachable without credentials so the
// initial page load works.
const isPublic = (path: string) =>
  PUBLIC_PATHS.has(path) || path.startsWith('/docs/') || path.startsWith('/dashboard/');

function timingSafeEqualStr(a: string, expected: Buffer): boolean {
  const candidate = Buffer.from(a);
  if (candidate.length !== expected.length) {
    // Burn a comparison against a dummy of equal length so length-mismatch
    // doesn't leak via timing. Cheap and deterministic.
    crypto.timingSafeEqual(expected, expected);
    return false;
  }
  return crypto.timingSafeEqual(candidate, expected);
}

export const authMiddleware: RequestHandler = (req, res, next) => {
  if (isPublic(req.path)) return next();

  const raw = req.headers['x-worker-secret'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !timingSafeEqualStr(header, SECRET_BUF)) {
    sendError(req, res, 401, 'UNAUTHORIZED', 'Missing or invalid X-Worker-Secret');
    return;
  }
  next();
};
