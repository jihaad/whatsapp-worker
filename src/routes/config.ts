import { Router } from 'express';
import { z } from 'zod';
import { getQuietHoursConfig, setQuietHoursConfig, isQuietHour, secondsUntilNextSendWindow } from '../anti-ban';
import { writeEnvVars } from '../lib/env-writer';
import { sendError } from '../lib/errors';
import { logger } from '../logger';

const router = Router();
const log = logger.child({ component: 'config-route' });

/**
 * Runtime-editable worker configuration. Today this is only quiet-hours;
 * the route is namespaced under /v1/config so future settings (rate-limit
 * caps, body variation toggle, etc.) can be added without further URL
 * churn.
 *
 * Source of truth lives in the worker's `.env` file. The PUT handler:
 *   1. validates the new values via setQuietHoursConfig (throws on bad input)
 *   2. rewrites the matching keys in `.env` via writeEnvVars
 *   3. returns the new effective config + current state (live | quiet)
 *
 * The DB is intentionally NOT touched — quiet-hours is operator config,
 * not domain data. Persisting via `.env` keeps it visible to whoever SSHes
 * onto the host without needing a DB query.
 */

const QuietHoursBodySchema = z.object({
  start: z.number().int().min(0).max(23),
  end:   z.number().int().min(1).max(24),
  tz:    z.string().min(1),
});

router.get('/quiet-hours', (_req, res) => {
  const cfg = getQuietHoursConfig();
  res.json({
    ...cfg,
    state: isQuietHour() ? 'quiet' : 'live',
    retryAfter: isQuietHour() ? secondsUntilNextSendWindow() : 0,
  });
});

router.put('/quiet-hours', async (req, res) => {
  const parsed = QuietHoursBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(req, res, 400, 'BAD_REQUEST',
      'Invalid body — expected { start: 0-23, end: 1-24, tz: IANA-timezone }',
      { details: parsed.error.flatten() });
  }

  const { start, end, tz } = parsed.data;
  try { setQuietHoursConfig({ start, end, tz }); }
  catch (err) {
    return sendError(req, res, 400, 'BAD_REQUEST', err instanceof Error ? err.message : 'invalid config');
  }

  try {
    await writeEnvVars({
      QUIET_HOUR_START: start,
      QUIET_HOUR_END:   end,
      QUIET_HOUR_TZ:    tz,
    });
  } catch (err) {
    // In-memory state was updated successfully; the .env write failure means
    // the change won't survive a restart but the running worker will respect
    // it. Log loudly and surface a 500 so the operator can investigate.
    log.error({ err }, 'failed to persist quiet-hours config to .env');
    return sendError(req, res, 500, 'INTERNAL',
      'Config updated in memory but failed to persist to .env — change will be lost on restart');
  }

  log.warn({ start, end, tz }, 'quiet-hours config updated via API');
  const cfg = getQuietHoursConfig();
  res.json({
    ...cfg,
    state: isQuietHour() ? 'quiet' : 'live',
    retryAfter: isQuietHour() ? secondsUntilNextSendWindow() : 0,
  });
});

export default router;
