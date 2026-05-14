import { Router } from 'express';
import { initSession, getSession, listSessions, destroySession, sendMessage } from '../sessions';
import { sleepJitter } from '../anti-ban';
import { quietHoursGuard } from '../middleware/quiet-hours';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const sessions = await listSessions();
    res.json({ sessions });
  } catch (err) {
    console.error('[worker] GET /sessions:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list sessions' });
  }
});

router.post('/:sessionId', async (req, res) => {
  try {
    const session = await initSession(req.params.sessionId);
    res.json({ session });
  } catch (err) {
    console.error(`[worker] POST /sessions/${req.params.sessionId}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to init session' });
  }
});

router.get('/:sessionId', async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    res.json({ session });
  } catch (err) {
    console.error(`[worker] GET /sessions/${req.params.sessionId}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get session' });
  }
});

router.delete('/:sessionId', async (req, res) => {
  try {
    await destroySession(req.params.sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error(`[worker] DELETE /sessions/${req.params.sessionId}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to destroy session' });
  }
});

// Legacy alias — remove once FD's client.ts calls /messages/send instead.
router.post('/:sessionId/send', quietHoursGuard, async (req, res) => {
  const schoolId = req.params.sessionId as string;
  const { to, body } = req.body as { to?: string; body?: string };
  if (!to || !body) {
    res.status(400).json({ error: '`to` and `body` are required' });
    return;
  }

  try {
    await sleepJitter();
    const result = await sendMessage(schoolId, to, body);
    res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    console.error(`[worker] POST /sessions/${schoolId}/send:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send message' });
  }
});

export default router;
