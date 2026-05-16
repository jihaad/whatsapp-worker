import { Router } from 'express';
import { prisma } from '../prisma';

const router = Router();

const READY_DB_TIMEOUT_MS = 2_000;

/**
 * Liveness — cheap, always 200 while the process is alive. Used by Cloudflare
 * Tunnel for traffic gating and by uptime monitors. Does NOT touch the DB:
 * an unreachable database should not flag this instance for restart.
 */
router.get('/', (_, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/**
 * Readiness — pings Prisma with a 2 s timeout. Returns 503 when the DB is
 * unreachable so orchestrators can pull this instance from rotation without
 * killing the process. The recent Cloudflare tunnel outage (stale hostname in
 * DATABASE_URL) is exactly the scenario this catches.
 */
router.get('/ready', async (_req, res) => {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('readiness DB ping timed out')), READY_DB_TIMEOUT_MS),
  );

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    res.json({ ok: true, uptime: process.uptime(), checks: { db: 'ok' } });
  } catch (err) {
    res.status(503).json({
      ok: false,
      uptime: process.uptime(),
      checks: { db: 'fail' },
      reason: err instanceof Error ? err.message : 'unknown',
    });
  }
});

export default router;
