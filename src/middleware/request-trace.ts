import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { eventBus } from '../events';

/**
 * Request tracer — captures every authenticated HTTP request + its response
 * and publishes a single `http.request` event after the response finishes.
 * The dashboard's Network panel subscribes to these for ops debugging.
 *
 * Order: mount AFTER pino-http (so req.id is set), AFTER express.json (so
 * req.body is parsed), and BEFORE the global rate limiter so we trace 429s
 * and 401s too. Per-route auth still runs after, so the trace event sees
 * the final status code from any middleware in the chain.
 *
 * Skips operator-side noise: probes (`/health`, `/health/ready`, `/metrics`),
 * the SSE stream itself (would create a feedback loop), and the static
 * dashboard HTML / docs UI. The /events/recent backfill endpoint IS traced
 * because it's a legitimate API call worth surfacing in the Network view.
 *
 * Bodies are capped at MAX_BODY_BYTES and truncated with an `…(truncated)`
 * marker. Sensitive request headers (worker secret, Authorization, Cookie)
 * are stripped before publishing — the dashboard can show everything else.
 */

const MAX_BODY_BYTES = 4_096;
const SENSITIVE_HEADERS = new Set([
  'x-worker-secret',
  'authorization',
  'cookie',
  'set-cookie',
]);

function shouldSkip(path: string): boolean {
  if (path === '/health' || path === '/health/ready' || path === '/metrics') return true;
  // The SSE stream is long-lived — tracing it would publish one event per
  // delivered chunk, drowning everything else.
  if (path === '/events') return true;
  // Dashboard HTML + assets are operator UI, not API traffic.
  if (path === '/dashboard' || path.startsWith('/dashboard/')) return true;
  return false;
}

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

function truncate(value: unknown): { text: string; truncated: boolean; parsed?: unknown } {
  if (value === undefined || value === null) return { text: '', truncated: false };
  let text: string;
  let parsed: unknown;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      parsed = value;
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > MAX_BODY_BYTES) {
    return { text: text.slice(0, MAX_BODY_BYTES) + '…(truncated)', truncated: true, parsed: undefined };
  }
  return { text, truncated: false, parsed };
}

export const requestTrace: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (shouldSkip(req.path)) return next();

  const startedAt = Date.now();

  // Capture response JSON / send body. Idempotency middleware also wraps
  // res.json — its wrapper still runs and replays from cache, but our wrap
  // happens first chronologically so it observes whatever the final
  // handler emitted. Both wrappers cooperate cleanly because each just
  // delegates to the previous reference.
  let responseBody: unknown;
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    responseBody = body;
    return originalJson(body);
  };
  const originalSend = res.send.bind(res);
  res.send = function (body: unknown) {
    // Only capture if json() didn't already grab it.
    if (responseBody === undefined) responseBody = body;
    return originalSend(body);
  };

  // The dashboard tags its own fetches (sessions refresh, /events SSE,
  // /events/recent backfill) with X-Dashboard-Internal: 1 so the operator
  // can hide them from the Network panel by default. The trace still fires
  // — we just mark `internal: true` and let the client filter.
  const isInternal = req.headers['x-dashboard-internal'] === '1';

  res.on('finish', () => {
    const latencyMs = Date.now() - startedAt;
    const reqBody = truncate(req.body);
    const resBody = truncate(responseBody);
    eventBus.publish('http.request', {
      requestId: String(req.id ?? ''),
      method: req.method,
      path: req.originalUrl ?? req.url,
      status: res.statusCode,
      latencyMs,
      ip: req.ip ?? req.socket?.remoteAddress ?? null,
      reqHeaders: redactHeaders(req.headers as Record<string, unknown>),
      reqBody: reqBody.text,
      reqBodyTruncated: reqBody.truncated,
      resBody: resBody.text,
      resBodyTruncated: resBody.truncated,
      contentType: res.getHeader('content-type') ?? null,
      internal: isInternal,
    });
  });

  next();
};
