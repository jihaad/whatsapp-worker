import express from 'express';
import { initSession, getSession, listSessions, destroySession, sendMessage, restoreSessions, persistAndDestroyAll } from './sessions';
import { isQuietHour, secondsUntilNextSendWindow, sleepJitter } from './anti-ban';

/**
 * fd-whatsapp-worker — pure-API entry point.
 *
 * The worker is a transport-only service. FD calls these endpoints over
 * HTTPS (via Cloudflare Tunnel) for QR-linking, status polling, and
 * sending messages. It has no internal queue, no FD database access
 * beyond its own `whatsapp_sessions` table, and no domain knowledge of
 * schools / students / classes.
 *
 * Auth: legacy shared `WHATSAPP_WORKER_SECRET` header until Phase 1 of
 * the design plan replaces it with HMAC-signed service tokens.
 */

// whatsapp-web.js attaches an async `framenavigated` listener that calls
// `this.inject()` without a try/catch (Client.js ~L383). When WhatsApp Web
// navigates mid-inject the puppeteer call throws "Execution context was
// destroyed", which surfaces here as an unhandled rejection and — under
// Node's default — kills the worker. Swallow these transient puppeteer
// rejections so one blip doesn't take down every session.
const TRANSIENT_PUPPETEER_ERRORS = [
  'Execution context was destroyed',
  'Target closed',
  'Session closed',
  'Protocol error',
];
const isTransientPuppeteerError = (msg: string) =>
  TRANSIENT_PUPPETEER_ERRORS.some((needle) => msg.includes(needle));

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (isTransientPuppeteerError(msg)) {
    console.warn('[worker] swallowed transient puppeteer rejection:', msg);
    return;
  }
  console.error('[worker] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (isTransientPuppeteerError(msg)) {
    console.warn('[worker] swallowed transient puppeteer exception:', msg);
    return;
  }
  console.error('[worker] uncaughtException:', err);
  process.exit(1);
});

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT ?? process.env.WHATSAPP_WORKER_PORT ?? 3001);
const HOST = process.env.WHATSAPP_WORKER_HOST ?? '127.0.0.1';
const SECRET = process.env.WHATSAPP_WORKER_SECRET ?? 'dev-worker-secret';

// ---------------------------------------------------------------------------
// Auth middleware — shared secret header so only the FD app can call this.
// `/health` is public for Cloudflare Tunnel + uptime monitor probes.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const header = req.headers['x-worker-secret'];
  if (header !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', (_, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// Sessions — CRUD + polling
// ---------------------------------------------------------------------------

/** List every known session. Drives FD's dashboards/sidebars. */
app.get('/sessions', async (_req, res) => {
  try {
    const sessions = await listSessions();
    res.json({ sessions });
  } catch (err) {
    console.error('[worker] GET /sessions:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list sessions' });
  }
});

/** Init or return the current session for a school. */
app.post('/sessions/:schoolId', async (req, res) => {
  try {
    const session = await initSession(req.params.schoolId);
    res.json({ session });
  } catch (err) {
    console.error(`[worker] POST /sessions/${req.params.schoolId}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to init session' });
  }
});

/** Poll session status + QR. */
app.get('/sessions/:schoolId', async (req, res) => {
  try {
    const session = await getSession(req.params.schoolId);
    res.json({ session });
  } catch (err) {
    console.error(`[worker] GET /sessions/${req.params.schoolId}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get session' });
  }
});

/** Unlink and destroy the session. */
app.delete('/sessions/:schoolId', async (req, res) => {
  try {
    await destroySession(req.params.schoolId);
    res.json({ success: true });
  } catch (err) {
    console.error(`[worker] DELETE /sessions/${req.params.schoolId}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to destroy session' });
  }
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Send a single WhatsApp message. Body: `{ schoolId, recipient, body }`.
 *
 * Anti-ban posture applied inline: quiet-hours guard rejects with 503 +
 * `Retry-After`, then a 5–15s random jitter before the actual send.
 * Caller waits up to ~15s for the synchronous response.
 *
 * For bulk sends, the FD-side cron iterates due reminders and POSTs each
 * one individually — no internal queue here.
 */
app.post('/messages/send', async (req, res) => {
  const { schoolId, recipient, body } = req.body as {
    schoolId?: string; recipient?: string; body?: string;
  };

  if (!schoolId || !recipient || !body) {
    res.status(400).json({ error: '`schoolId`, `recipient`, and `body` are required' });
    return;
  }

  if (isQuietHour()) {
    const retryAfter = secondsUntilNextSendWindow();
    res.set('Retry-After', String(retryAfter));
    res.status(503).json({
      error: 'Quiet hours — sends paused outside 07:00–21:00 EAT',
      code: 'QUIET_HOURS',
      retryAfter,
    });
    return;
  }

  try {
    await sleepJitter();
    const result = await sendMessage(schoolId, recipient, body);
    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    console.error(`[worker] POST /messages/send for ${schoolId} → ${recipient}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send message' });
  }
});

/**
 * Legacy alias — kept while FD migrates from `/sessions/:id/send` to the
 * unified `/messages/send`. Delete once `src/lib/whatsapp-worker/client.ts`
 * on the FD side is updated to call the new path. Same anti-ban posture.
 */
app.post('/sessions/:schoolId/send', async (req, res) => {
  const { to, body } = req.body as { to?: string; body?: string };
  if (!to || !body) {
    res.status(400).json({ error: '`to` and `body` are required' });
    return;
  }

  if (isQuietHour()) {
    const retryAfter = secondsUntilNextSendWindow();
    res.set('Retry-After', String(retryAfter));
    res.status(503).json({
      error: 'Quiet hours — sends paused outside 07:00–21:00 EAT',
      code: 'QUIET_HOURS',
      retryAfter,
    });
    return;
  }

  try {
    await sleepJitter();
    const result = await sendMessage(req.params.schoolId, to, body);
    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    console.error(`[worker] POST /sessions/${req.params.schoolId}/send:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send message' });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, HOST, () => {
  console.log(`[worker] WhatsApp worker listening on http://${HOST}:${PORT}`);
  console.log(`[worker] Restoring saved sessions…`);
  void restoreSessions();
});

// Graceful shutdown — close Chromium cleanly and persist settled sessions
// to the DB so the next start can restore without a fresh QR. Re-entrant:
// if two signals arrive close together (ctrl-c then SIGTERM from tsx watch)
// the second one is a no-op while the first finishes.
let shuttingDown = false;
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[worker] Shutting down…');
  try {
    await persistAndDestroyAll();
  } catch (e) {
    console.error('[worker] shutdown persist error:', e);
  }
  process.exit(0);
}
