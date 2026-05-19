import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from './lib/errors';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();
registry.register('ErrorResponse', ErrorResponseSchema);

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const SessionSchema = registry.register('Session', z.object({
  sessionId:    z.string().uuid().openapi({ description: 'Session UUID' }),
  status:       z.enum(['disconnected', 'connecting', 'qr_pending', 'ready']),
  qrDataUrl:    z.string().nullable().openapi({ description: 'Base64 PNG data URL — set only when status is qr_pending' }),
  phoneNumber:  z.string().nullable().openapi({ description: 'Linked phone number once ready' }),
  lastActivity: z.string().openapi({ description: 'ISO 8601 timestamp' }),
  readySince:   z.string().nullable().openapi({ description: 'ISO 8601 timestamp of when the session most recently entered `ready` state. Null whenever status !== ready. Use to compute connected-for duration.' }),
}));

// HTTP 200 shape for a single send. The `success` boolean was dropped — the
// status code conveys it. Failures use the standard error envelope (502
// SEND_FAILED) defined in src/lib/errors.ts.
export const SendMessageResultSchema = registry.register('SendMessageResult', z.object({
  messageId:      z.string().nullable().openapi({ description: 'WhatsApp message id once delivered to the queue' }),
  recipientPhone: z.string().openapi({ description: 'Phone number as received (pre-normalisation)' }),
  timestamp:      z.string().openapi({ description: 'Worker-side ISO 8601 timestamp at the moment the WhatsApp sendMessage call returned' }),
}));

export const BulkMessageResultSchema = registry.register('BulkMessageResult', z.object({
  index:     z.number().int(),
  recipient: z.string(),
  success:   z.boolean(),
  messageId: z.string().nullable(),
  error:     z.string().optional(),
  timestamp: z.string(),
}));

export const BulkBatchSchema = registry.register('BulkBatch', z.object({
  batchId:      z.string().uuid(),
  sessionId:    z.string().uuid(),
  status:       z.enum(['processing', 'complete', 'interrupted']).openapi({
    description: '`processing` = send loop active; `complete` = loop finished (possibly with failures); `interrupted` = worker restarted mid-batch — the caller may requeue unsent items.',
  }),
  total:        z.number().int(),
  succeeded:    z.number().int(),
  failed:       z.number().int(),
  results:      z.array(BulkMessageResultSchema),
  startedAt:    z.string(),
  completedAt:  z.string().optional(),
}));

// ---------------------------------------------------------------------------
// Request schemas (also used for runtime validation in routes)
// ---------------------------------------------------------------------------

// Override semantics: when set (via body field OR `X-Worker-Override: 1`
// header), skip all rate-limit/cooldown/quiet-hours/jitter gates. Still
// secret-gated by the regular auth middleware; logs at warn level on every
// use; surfaces with an OVERRIDE badge on the dashboard. Auth and the
// liveness probe still apply — can't send through a dead socket.
const OverrideField = z.boolean().optional().openapi({
  description: 'If true, bypass every anti-ban gate (quiet hours, HTTP send rate-limit, per-recipient cooldown, per-account/warmup/global token buckets, inter-message jitter). Auth, liveness probe, and body variation still apply. **High ban risk** — use sparingly for urgent / operational sends. Equivalent to passing the header `X-Worker-Override: 1`.',
});

export const SendMessageBodySchema = z.object({
  sessionId: z.string().min(1).openapi({ description: 'UUID of the session to send from' }),
  recipient: z.string().min(1).openapi({ description: 'Phone number — E.164, local 07…, or any common format' }),
  body:      z.string().min(1).openapi({ description: 'Message text' }),
  override:  OverrideField,
});

export const SendBulkBodySchema = z.object({
  sessionId: z.string().min(1).openapi({ description: 'UUID of the session to send from' }),
  messages: z.array(z.object({
    recipient: z.string().min(1).openapi({ description: 'Phone number' }),
    body:      z.string().min(1).openapi({ description: 'Message text' }),
  })).min(1).max(500).openapi({ description: '1–500 message objects' }),
  override:  OverrideField,
});

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

const rateLimitedResponse = errorResponse(
  'Rate limit exceeded — body.error.code is "RATE_LIMITED"; `Retry-After` header and `error.retryAfter` give the wait in seconds. Draft-7 `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers are also set.',
);

// Send endpoints can return 429 from EITHER the HTTP per-IP limiter OR one
// of the messaging-layer anti-ban guards inside sendMessage(). One status
// code, several distinct `error.code` values.
const sendRateLimitedResponse = errorResponse(
  'Rate limit exceeded. `error.code` is one of: `RATE_LIMITED` (HTTP per-IP cap — 30/min on send endpoints), `RECIPIENT_COOLDOWN` (same number sent within 5 min), `ACCOUNT_RATE_LIMIT` (30 msg/min per linked account), `WARMUP_LIMIT` (first 7 days have a lower cap, ramping from 5 → 30 msg/min), `GLOBAL_RATE_LIMIT` (100 msg/min across all accounts). `Retry-After` header + `error.retryAfter` give the wait in seconds.',
);

// ---------------------------------------------------------------------------
// Path registrations
// ---------------------------------------------------------------------------

registry.registerPath({
  method: 'get', path: '/health',
  summary: 'Liveness probe',
  description: 'Public — no auth required. Cheap, always 200 while the process is alive. Does NOT touch the DB — used by Cloudflare Tunnel and uptime monitors for traffic gating. For "is the worker ready to serve?" use GET /health/ready instead.',
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean(), uptime: z.number() }) } } },
  },
});

registry.registerPath({
  method: 'get', path: '/health/ready',
  summary: 'Readiness probe',
  description: 'Public — no auth required. Pings Prisma with a 2 s timeout. 200 when the worker can serve requests, 503 when it cannot. Orchestrators should use this to pull the instance from rotation rather than restart it (use /health for restart decisions).',
  responses: {
    200: {
      description: 'Ready — DB reachable',
      content: { 'application/json': { schema: z.object({
        ok: z.literal(true),
        uptime: z.number(),
        checks: z.object({ db: z.literal('ok') }),
      }) } },
    },
    503: {
      description: 'Not ready — DB unreachable or ping timed out',
      content: { 'application/json': { schema: z.object({
        ok: z.literal(false),
        uptime: z.number(),
        checks: z.object({ db: z.literal('fail') }),
        reason: z.string(),
      }) } },
    },
  },
});

registry.registerPath({
  method: 'get', path: '/v1/sessions',
  summary: 'List sessions (paginated)',
  description: 'Returns sessions sorted by sessionId ascending. Pass `nextCursor` back as `?cursor=` to fetch the next page. `nextCursor` is null when no more pages remain. Default limit is 50; max 200.',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional().openapi({ description: 'Max items per page (1-200, default 50)', example: 50 }),
      cursor: z.string().optional().openapi({ description: 'Opaque cursor from the previous response. Treat as opaque — do not parse.', example: 'eyJsYXN0U2Vzc2lvbklkIjoiMDFhYi0uLi4ifQ' }),
    }),
  },
  responses: {
    200: {
      description: 'Page of sessions',
      content: { 'application/json': { schema: z.object({
        sessions: z.array(SessionSchema),
        nextCursor: z.string().nullable().openapi({ description: 'Pass back as `?cursor=`; null when no more pages.' }),
      }) } },
    },
    400: errorResponse('Invalid query parameter — error.details contains Zod issues'),
    401: errorResponse('Missing or invalid X-Worker-Secret'),
    429: rateLimitedResponse,
    500: errorResponse('Internal error'),
  },
});

registry.registerPath({
  method: 'post', path: '/v1/sessions/{sessionId}',
  summary: 'Init or return a session',
  description: 'Initialises a new WhatsApp Web session, or returns the existing one. Chromium boots in the background — poll GET /v1/sessions/{sessionId} every 2s.',
  request: { params: z.object({ sessionId: z.string().uuid() }) },
  responses: {
    200: { description: 'Session', content: { 'application/json': { schema: z.object({ session: SessionSchema }) } } },
    401: errorResponse('Missing or invalid X-Worker-Secret'),
    429: rateLimitedResponse,
    500: errorResponse('Internal error'),
  },
});

registry.registerPath({
  method: 'get', path: '/v1/sessions/{sessionId}',
  summary: 'Poll session status & QR',
  request: { params: z.object({ sessionId: z.string().uuid() }) },
  responses: {
    200: { description: 'Session', content: { 'application/json': { schema: z.object({ session: SessionSchema.nullable() }) } } },
    401: errorResponse('Missing or invalid X-Worker-Secret'),
    429: rateLimitedResponse,
    500: errorResponse('Internal error'),
  },
});

registry.registerPath({
  method: 'delete', path: '/v1/sessions/{sessionId}',
  summary: 'Unlink and destroy a session',
  request: { params: z.object({ sessionId: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Destroyed — body confirms the sessionId that was unlinked',
      content: { 'application/json': { schema: z.object({ sessionId: z.string().uuid() }) } },
    },
    401: errorResponse('Missing or invalid X-Worker-Secret'),
    429: rateLimitedResponse,
    500: errorResponse('Internal error'),
  },
});

const idempotencyKeyHeader = z.object({
  'Idempotency-Key': z.string().min(8).max(200).optional().openapi({
    description: 'Optional opaque key (8–200 chars). Worker caches the response for 24 h and replays it on retry, so a timed-out request can be retried safely without double-sending. Cache is in-memory; key reuse with a different body returns 422.',
    example: 'fd-2026-05-16-school-9f3e-msg-42',
  }),
  'X-Worker-Override': z.string().optional().openapi({
    description: '**High ban risk.** Set to `1` (or any truthy string) to bypass every anti-ban gate: quiet hours, HTTP send rate-limit, per-recipient cooldown, per-account / warmup / global token buckets, inter-message jitter. Auth, liveness probe, idempotency, and body variation still apply. Equivalent to passing `{ "override": true }` in the request body. Every override-tagged send is logged at `warn` level and surfaces with an ⚠ OVERRIDE badge on the dashboard.',
    example: '1',
  }),
});

registry.registerPath({
  method: 'post', path: '/v1/messages/send',
  summary: 'Send a single message',
  description: `Applies quiet-hours guard and 5–15s anti-ban jitter before sending. Caller waits up to ~15s for the response. Pass an Idempotency-Key header to make retries safe.`,
  request: {
    headers: idempotencyKeyHeader,
    body: { content: { 'application/json': { schema: SendMessageBodySchema } } },
  },
  responses: {
    200: { description: 'Sent (or replayed from idempotency cache — see Idempotent-Replay response header)', content: { 'application/json': { schema: SendMessageResultSchema } } },
    400: errorResponse('Invalid request body — error.details contains Zod issues'),
    401: errorResponse('Missing or invalid X-Worker-Secret'),
    409: errorResponse('Another request with this Idempotency-Key is still in flight'),
    422: errorResponse('Idempotency-Key reused with a different request body'),
    429: sendRateLimitedResponse,
    500: errorResponse('Internal error'),
    502: errorResponse('Send failed — error.code is "SEND_FAILED"; error.details carries recipientPhone + timestamp'),
    503: errorResponse(
      'Send not currently possible. `error.code` is one of: `QUIET_HOURS` (outside the configured 07:00–21:00 EAT window — body carries `retryAfter` seconds), `SESSION_UNHEALTHY` (the underlying WhatsApp Web socket dropped; worker has kicked off a debounced reinit — caller should retry after `retryAfter` seconds).',
    ),
  },
});

registry.registerPath({
  method: 'post', path: '/v1/messages/send-bulk',
  summary: 'Send multiple messages',
  description: 'Enqueues up to 500 messages for sequential background delivery with anti-ban jitter between each. Returns immediately — poll GET /v1/messages/send-bulk/{batchId} for progress. Pass an Idempotency-Key header so a retried submission returns the original batchId instead of spawning a second batch.',
  request: {
    headers: idempotencyKeyHeader,
    body: { content: { 'application/json': { schema: SendBulkBodySchema } } },
  },
  responses: {
    202: { description: 'Accepted (or replayed from idempotency cache — see Idempotent-Replay response header)', content: { 'application/json': { schema: z.object({ batchId: z.string().uuid(), total: z.number().int(), status: z.literal('processing') }) } } },
    400: errorResponse('Invalid request body'),
    401: errorResponse('Missing or invalid X-Worker-Secret'),
    409: errorResponse('Another request with this Idempotency-Key is still in flight'),
    422: errorResponse('Idempotency-Key reused with a different request body'),
    429: sendRateLimitedResponse,
    503: errorResponse(
      'Send not currently possible. `error.code` is one of: `QUIET_HOURS` (outside the configured 07:00–21:00 EAT window — body carries `retryAfter` seconds), `SESSION_UNHEALTHY` (the underlying WhatsApp Web socket dropped; worker has kicked off a debounced reinit — caller should retry after `retryAfter` seconds).',
    ),
  },
});

registry.registerPath({
  method: 'get', path: '/v1/messages/send-bulk/{batchId}',
  summary: 'Poll bulk send progress',
  description: 'Returns current batch state. Poll until status is "complete". Batches are held for 24 hours after completion.',
  request: { params: z.object({ batchId: z.string().uuid() }) },
  responses: {
    200: { description: 'Batch state', content: { 'application/json': { schema: BulkBatchSchema } } },
    401: errorResponse('Missing or invalid X-Worker-Secret'),
    404: errorResponse('Batch not found'),
    429: rateLimitedResponse,
  },
});

// ---------------------------------------------------------------------------
// Generate spec
// ---------------------------------------------------------------------------

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiSpec = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'whatsapp-worker',
    version: '1.0.0',
    description: 'Transport-only WhatsApp Web API — sessions, messaging, and bulk sends. All endpoints are mounted under `/v1`; `/health`, `/metrics`, and `/docs` stay unversioned.',
  },
  servers: [{ url: process.env.WHATSAPP_WORKER_URL ?? 'https://worker.example.com' }],
});
