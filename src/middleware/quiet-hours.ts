import type { RequestHandler } from 'express';
import { isQuietHour, secondsUntilNextSendWindow, QUIET_HOURS_MESSAGE } from '../anti-ban';
import { sendError } from '../lib/errors';

export const quietHoursGuard: RequestHandler = (req, res, next) => {
  if (!isQuietHour()) return next();
  sendError(req, res, 503, 'QUIET_HOURS', QUIET_HOURS_MESSAGE, {
    retryAfter: secondsUntilNextSendWindow(),
  });
};
