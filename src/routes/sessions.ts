import { Router } from 'express';
import { z } from 'zod';
import { initSession, getSession, listSessions, destroySession } from '../sessions';
import { sendError } from '../lib/errors';

const router = Router();

const ListSessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

router.get('/', async (req, res) => {
  const parsed = ListSessionsQuery.safeParse(req.query);
  if (!parsed.success) {
    sendError(req, res, 400, 'BAD_REQUEST', 'Invalid query', { details: parsed.error.issues });
    return;
  }
  const limit = parsed.data.limit ?? 50;

  try {
    const result = await listSessions({ limit, cursor: parsed.data.cursor });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'GET /sessions failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to list sessions');
  }
});

router.post('/:sessionId', async (req, res) => {
  try {
    const session = await initSession(req.params.sessionId);
    res.json({ session });
  } catch (err) {
    req.log.error({ err, sessionId: req.params.sessionId }, 'POST /sessions/:sessionId failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to init session');
  }
});

router.get('/:sessionId', async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    res.json({ session });
  } catch (err) {
    req.log.error({ err, sessionId: req.params.sessionId }, 'GET /sessions/:sessionId failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to get session');
  }
});

router.delete('/:sessionId', async (req, res) => {
  try {
    await destroySession(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId });
  } catch (err) {
    req.log.error({ err, sessionId: req.params.sessionId }, 'DELETE /sessions/:sessionId failed');
    sendError(req, res, 500, 'INTERNAL', 'Failed to destroy session');
  }
});

export default router;
