import express from 'express';
import { initSession, getSession, destroySession, sendMessage, restoreSessions } from './sessions';

const app = express();
app.use(express.json());

const PORT = Number(process.env.WHATSAPP_WORKER_PORT ?? 3001);
const SECRET = process.env.WHATSAPP_WORKER_SECRET ?? 'dev-worker-secret';

// ---------------------------------------------------------------------------
// Auth middleware — shared secret header so only the Next.js app can call this
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  // Health check is always public
  if (req.path === '/health') return next();

  const header = req.headers['x-worker-secret'];
  if (header !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_, res) => {
  res.json({ ok: true, uptime: process.uptime() });
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

/** Send a WhatsApp message. Body: { to, body } */
app.post('/sessions/:schoolId/send', async (req, res) => {
  try {
    const { to, body } = req.body as { to?: string; body?: string };
    if (!to || !body) {
      res.status(400).json({ error: '`to` and `body` are required' });
      return;
    }
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
app.listen(PORT, () => {
  console.log(`[worker] WhatsApp worker listening on http://localhost:${PORT}`);
  console.log(`[worker] Restoring saved sessions…`);
  void restoreSessions();
});

// Graceful shutdown — destroy all active Chromium instances cleanly
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  console.log('[worker] Shutting down…');
  process.exit(0);
}
