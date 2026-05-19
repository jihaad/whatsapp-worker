import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { restoreSessions, persistAndDestroyAll } from './sessions';
import { authMiddleware } from './middleware/auth';
import { requestTrace } from './middleware/request-trace';
import { globalLimiter } from './lib/rate-limit';
import { markInterruptedBatches, startBulkBatchEviction } from './lib/bulk-batch-maintenance';
import { startEventPersistence } from './lib/event-persistence';
import { startSessionWatchdog } from './lib/session-watchdog';
import { registry } from './metrics';
import healthRouter from './routes/health';
import docsRouter from './routes/docs';
import sessionsRouter from './routes/sessions';
import messagesRouter from './routes/messages';
import eventsRouter from './routes/events';
import dashboardRouter from './routes/dashboard';
import faviconRouter from './routes/favicon';

// whatsapp-web.js fires async `framenavigated` events without try/catch. When
// WhatsApp Web navigates mid-inject, Puppeteer throws "Execution context was
// destroyed" as an unhandled rejection. Swallow these transient errors so one
// navigation blip doesn't kill every active session.
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
    logger.warn({ msg }, 'swallowed transient puppeteer rejection');
    return;
  }
  logger.error({ err: reason }, 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (isTransientPuppeteerError(msg)) {
    logger.warn({ msg }, 'swallowed transient puppeteer exception');
    return;
  }
  logger.fatal({ err }, 'uncaughtException');
  process.exit(1);
});

const app = express();
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) =>
      req.url === '/health' ||
      req.url === '/health/ready' ||
      req.url === '/metrics' ||
      req.url === '/events' ||
      req.url === '/dashboard' ||
      (req.url ?? '').startsWith('/dashboard/') ||
      req.url === '/favicon.ico' ||
      req.url === '/favicon.svg',
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Surface method + url + status + latency in the message string so the
  // dev terminal shows it inline. pino-pretty hides `req`/`res` in dev
  // (see src/logger.ts ignore list); prod JSON consumers still get the
  // full structured payload.
  customSuccessMessage: (req, res, responseTime) =>
    `${req.method} ${req.url} ${res.statusCode} (${responseTime}ms)`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} ${res.statusCode} — ${err instanceof Error ? err.message : String(err)}`,
}));
// Echo the pino-http-generated request ID so callers can correlate logs.
app.use((req, res, next) => {
  res.setHeader('X-Request-Id', String(req.id ?? ''));
  next();
});
// API responses carry QR codes, session status, phone numbers, and per-call
// idempotency replays — none of which should ever be cached by intermediaries
// (CDN, reverse proxy, browser). Default everything to no-store.
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '256kb' }));
// Trace every authenticated-API request (method/path/status/latency/headers/
// bodies) and publish to the eventBus. The dashboard's Network panel
// subscribes to these for ops debugging. Runs after express.json so req.body
// is parsed; runs before the rate limiter so 429s + 401s are also captured.
app.use(requestTrace);
// Global rate limit runs BEFORE auth so unauthenticated floods are throttled
// at the door. Send-specific limiter is applied per-route in src/routes/messages.ts.
app.use(globalLimiter);
app.use(authMiddleware);

// Infra endpoints stay unversioned — they're not part of the API contract.
// favicon mounts at app root (handler matches /favicon.svg + /favicon.ico)
// so the browser's auto-fetch from any page picks up the WhatsApp glyph.
app.use(faviconRouter);
app.use('/health', healthRouter);
app.use('/docs', docsRouter);
app.use('/dashboard', dashboardRouter);
app.use('/events', eventsRouter);

// Versioned API surface. Breaking changes go in /v2, not by mutating /v1.
app.use('/v1/sessions', sessionsRouter);
app.use('/v1/messages', messagesRouter);

app.get('/metrics', async (_, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

const PORT = Number(process.env.PORT ?? process.env.WHATSAPP_WORKER_PORT ?? 3001);
const HOST = process.env.WHATSAPP_WORKER_HOST ?? '127.0.0.1';

app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT }, 'WhatsApp worker listening');
  logger.info('Restoring saved sessions…');
  void restoreSessions();
  // Reconcile bulk batches left in 'processing' by the previous process, then
  // start the periodic 24h eviction sweep.
  void markInterruptedBatches();
  startBulkBatchEviction();
  // Subscribe to the eventBus and persist message events to Postgres so the
  // dashboard's feed survives worker restarts. 7-day retention; eviction
  // sweep runs hourly.
  startEventPersistence();
  // Probe every `ready` session every 5 min and flip status to
  // `disconnected` on a dead WhatsApp Web socket. Detect-only — never
  // auto-reinits (that would risk a ban from re-link bursts).
  startSessionWatchdog();
});

// Graceful shutdown — close Chromium cleanly and persist settled sessions so
// the next start restores without a fresh QR scan. Re-entrant: a second signal
// while shutdown is in progress is a no-op.
let shuttingDown = false;
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down…');
  try {
    await persistAndDestroyAll();
  } catch (err) {
    logger.error({ err }, 'shutdown persist error');
  }
  process.exit(0);
}
