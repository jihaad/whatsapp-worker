import express from 'express';
import morgan from 'morgan';
import { restoreSessions, persistAndDestroyAll } from './sessions';
import { authMiddleware } from './middleware/auth';
import { registry } from './metrics';
import healthRouter from './routes/health';
import docsRouter from './routes/docs';
import sessionsRouter from './routes/sessions';
import messagesRouter from './routes/messages';

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
app.use(morgan('[:date[clf]] :method :url :status :response-time ms'));
app.use(express.json({ limit: '256kb' }));
app.use(authMiddleware);

app.use('/health', healthRouter);
app.use('/docs', docsRouter);
app.use('/sessions', sessionsRouter);
app.use('/messages', messagesRouter);

app.get('/metrics', async (_, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

const PORT = Number(process.env.PORT ?? process.env.WHATSAPP_WORKER_PORT ?? 3001);
const HOST = process.env.WHATSAPP_WORKER_HOST ?? '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`[worker] WhatsApp worker listening on http://${HOST}:${PORT}`);
  console.log(`[worker] Restoring saved sessions…`);
  void restoreSessions();
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
  console.log('[worker] Shutting down…');
  try {
    await persistAndDestroyAll();
  } catch (e) {
    console.error('[worker] shutdown persist error:', e);
  }
  process.exit(0);
}
