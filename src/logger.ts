import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

// In dev (and any time JSON output is explicitly disabled), pipe through
// pino-pretty for human-readable single-line output. In prod, emit raw
// JSON so log aggregators (Loki/Datadog/etc.) can ingest it directly.
//
// pino-pretty runs in a worker thread via pino transports; cost is one
// startup tick, no per-log overhead.
const prettyTransport = !isProd && process.env.LOG_JSON !== '1'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        // Hide noisy fields. `req` / `res` are pino-http's verbose dumps —
        // anything we actually need (method, url, status, latency) is
        // hoisted onto the message itself by customSuccessMessage in
        // pino-http config (src/index.ts).
        ignore: 'pid,hostname,req,res,responseTime',
        singleLine: true,
        // Lift correlation IDs and the worker's frequent context fields
        // onto the prefix line so they're visible at a glance.
        messageFormat: '{if reqId}[{reqId}] {end}{if sessionId}[s:{sessionId}] {end}{if batchId}[b:{batchId}] {end}{msg}',
      },
    }
  : undefined;

export const logger = pino({
  name: 'worker',
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers["x-worker-secret"]',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.recipient',
      '*.phoneNumber',
      '*.body',
      '*.to',
    ],
    censor: '[redacted]',
  },
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});

export type Logger = typeof logger;
