import type { RequestHandler } from 'express';
import { isQuietHour, secondsUntilNextSendWindow, getQuietHoursMessage } from '../anti-ban';
import { sendError } from '../lib/errors';
import { hasOverride } from '../lib/override';

export const quietHoursGuard: RequestHandler = (req, res, next) => {
  if (!isQuietHour()) return next();
  // Override bypass — operator has explicitly opted out of anti-ban gates.
  // Logged loudly by the route handler.
  if (hasOverride(req)) return next();
  sendError(req, res, 503, 'QUIET_HOURS', getQuietHoursMessage(), {
    retryAfter: secondsUntilNextSendWindow(),
  });
};
