import type { RequestHandler } from 'express';
import { isQuietHour, secondsUntilNextSendWindow, QUIET_HOURS_MESSAGE } from '../anti-ban';

export const quietHoursGuard: RequestHandler = (_req, res, next) => {
  if (!isQuietHour()) return next();
  const retryAfter = secondsUntilNextSendWindow();
  res.set('Retry-After', String(retryAfter));
  res.status(503).json({ error: QUIET_HOURS_MESSAGE, code: 'QUIET_HOURS', retryAfter });
};
