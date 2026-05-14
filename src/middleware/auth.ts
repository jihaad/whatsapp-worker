import type { RequestHandler } from 'express';

if (!process.env.WHATSAPP_WORKER_SECRET) {
  console.warn('[worker] WHATSAPP_WORKER_SECRET is not set — running with insecure default');
}

const SECRET = process.env.WHATSAPP_WORKER_SECRET ?? 'dev-worker-secret';
const PUBLIC_PATHS = new Set(['/health', '/docs', '/metrics']);

export const authMiddleware: RequestHandler = (req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const raw = req.headers['x-worker-secret'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};
