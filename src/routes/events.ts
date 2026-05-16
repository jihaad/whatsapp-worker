import { Router } from 'express';
import { eventBus, type WorkerEvent } from '../events';
import { prisma } from '../prisma';
import { sendError } from '../lib/errors';

const router = Router();

const HEARTBEAT_MS = 25_000;
const RECENT_MAX_LIMIT = 1000;
const RECENT_DEFAULT_LIMIT = 200;

/**
 * Server-Sent Events stream of every worker event. Auth-gated by the global
 * auth middleware. Browsers can't set custom headers on EventSource, so the
 * dashboard uses a fetch-based reader (see src/routes/dashboard.ts) that
 * passes X-Worker-Secret like any other authenticated call.
 *
 * No buffering: a fresh subscriber only sees events emitted after subscribe
 * time. The dashboard fills the gap by also polling GET /v1/sessions on a
 * timer for the session table.
 */
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable nginx-style proxy buffering if anything sits between us and the
  // browser (Cloudflare Tunnel passes this through).
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  const listener = (event: WorkerEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  eventBus.on('event', listener);

  // Send a connection-established event so the client knows it's wired up.
  res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString(), data: {} })}\n\n`);

  // Backfill from the ring buffer so reconnects (e.g. after a tsx-watch
  // restart) don't show a blank feed. Marked `replay: true` so the dashboard
  // can render them distinctly if it wants to.
  for (const event of eventBus.snapshot()) {
    res.write(`data: ${JSON.stringify({ ...event, replay: true })}\n\n`);
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off('event', listener);
  });
});

/**
 * Historical events backfill — the dashboard fetches this on load so it can
 * render past sends/failures across worker restarts. Returns most-recent
 * first. Bounded by RECENT_MAX_LIMIT; 7-day retention in the table itself.
 */
router.get('/recent', async (req, res) => {
  const rawLimit = Number(req.query.limit ?? RECENT_DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, Math.trunc(rawLimit)), RECENT_MAX_LIMIT)
    : RECENT_DEFAULT_LIMIT;

  try {
    const rows = await prisma.whatsAppMessageEvent.findMany({
      orderBy: { ts: 'desc' },
      take: limit,
    });
    // Reshape into the same `{ type, ts, data }` envelope the SSE stream
    // emits so the dashboard can render with the same code path.
    const events = rows.map((r) => ({
      type: r.type,
      ts: r.ts.toISOString(),
      data: r.data as Record<string, unknown>,
    }));
    res.json({ events });
  } catch (err) {
    req.log.error({ err }, 'GET /events/recent failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to read recent events');
  }
});

export default router;
