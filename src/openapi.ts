import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { QUIET_HOUR_START, QUIET_HOUR_END, QUIET_HOUR_TZ } from './anti-ban';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const pad = (h: number) => String(h).padStart(2, '0');

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const SessionSchema = registry.register('Session', z.object({
  sessionId:    z.string().uuid().openapi({ description: 'Session UUID' }),
  status:       z.enum(['disconnected', 'connecting', 'qr_pending', 'ready']),
  qrDataUrl:    z.string().nullable().openapi({ description: 'Base64 PNG data URL — set only when status is qr_pending' }),
  phoneNumber:  z.string().nullable().openapi({ description: 'Linked phone number once ready' }),
  lastActivity: z.string().openapi({ description: 'ISO 8601 timestamp' }),
}));

export const SendMessageResultSchema = registry.register('SendMessageResult', z.object({
  success:       z.boolean(),
  messageId:     z.string().nullable(),
  recipientPhone: z.string(),
  error:         z.string().optional(),
  timestamp:     z.string(),
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
  status:       z.enum(['processing', 'complete']),
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

export const SendMessageBodySchema = z.object({
  sessionId: z.string().min(1).openapi({ description: 'UUID of the session to send from' }),
  recipient: z.string().min(1).openapi({ description: 'Phone number — E.164, local 07…, or any common format' }),
  body:      z.string().min(1).openapi({ description: 'Message text' }),
});

export const SendBulkBodySchema = z.object({
  sessionId: z.string().min(1).openapi({ description: 'UUID of the session to send from' }),
  messages: z.array(z.object({
    recipient: z.string().min(1).openapi({ description: 'Phone number' }),
    body:      z.string().min(1).openapi({ description: 'Message text' }),
  })).min(1).max(500).openapi({ description: '1–500 message objects' }),
});

// ---------------------------------------------------------------------------
// Quiet hours response (reused across send endpoints)
// ---------------------------------------------------------------------------

const QuietHoursResponseSchema = z.object({
  error:       z.string().openapi({ example: `Quiet hours — sends paused outside ${pad(QUIET_HOUR_START)}:00–${pad(QUIET_HOUR_END)}:00 (${QUIET_HOUR_TZ})` }),
  code:        z.literal('QUIET_HOURS'),
  retryAfter:  z.number().int().openapi({ description: 'Seconds until the send window opens' }),
});

const quietHoursResponse = {
  description: `Quiet hours — sends paused outside ${pad(QUIET_HOUR_START)}:00–${pad(QUIET_HOUR_END)}:00 (${QUIET_HOUR_TZ})`,
  content: { 'application/json': { schema: QuietHoursResponseSchema } },
};

// ---------------------------------------------------------------------------
// Path registrations
// ---------------------------------------------------------------------------

registry.registerPath({
  method: 'get', path: '/health',
  summary: 'Liveness probe',
  description: 'Public — no auth required. Used by Cloudflare Tunnel and uptime monitors.',
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean(), uptime: z.number() }) } } },
  },
});

registry.registerPath({
  method: 'get', path: '/sessions',
  summary: 'List all sessions',
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: z.object({ sessions: z.array(SessionSchema) }) } } },
  },
});

registry.registerPath({
  method: 'post', path: '/sessions/{sessionId}',
  summary: 'Init or return a session',
  description: 'Initialises a new WhatsApp Web session, or returns the existing one. Chromium boots in the background — poll GET /sessions/{sessionId} every 2s.',
  request: { params: z.object({ sessionId: z.string().uuid() }) },
  responses: {
    200: { description: 'Session', content: { 'application/json': { schema: z.object({ session: SessionSchema }) } } },
  },
});

registry.registerPath({
  method: 'get', path: '/sessions/{sessionId}',
  summary: 'Poll session status & QR',
  request: { params: z.object({ sessionId: z.string().uuid() }) },
  responses: {
    200: { description: 'Session', content: { 'application/json': { schema: z.object({ session: SessionSchema.nullable() }) } } },
  },
});

registry.registerPath({
  method: 'delete', path: '/sessions/{sessionId}',
  summary: 'Unlink and destroy a session',
  request: { params: z.object({ sessionId: z.string().uuid() }) },
  responses: {
    200: { description: 'Destroyed', content: { 'application/json': { schema: z.object({ success: z.boolean() }) } } },
  },
});

registry.registerPath({
  method: 'post', path: '/messages/send',
  summary: 'Send a single message',
  description: `Applies quiet-hours guard and 5–15s anti-ban jitter before sending. Caller waits up to ~15s for the response.`,
  request: { body: { content: { 'application/json': { schema: SendMessageBodySchema } } } },
  responses: {
    200: { description: 'Sent', content: { 'application/json': { schema: SendMessageResultSchema } } },
    502: { description: 'Send failed', content: { 'application/json': { schema: SendMessageResultSchema } } },
    503: quietHoursResponse,
  },
});

registry.registerPath({
  method: 'post', path: '/messages/send-bulk',
  summary: 'Send multiple messages',
  description: 'Enqueues up to 500 messages for sequential background delivery with anti-ban jitter between each. Returns immediately — poll GET /messages/send-bulk/{batchId} for progress.',
  request: { body: { content: { 'application/json': { schema: SendBulkBodySchema } } } },
  responses: {
    202: { description: 'Accepted', content: { 'application/json': { schema: z.object({ batchId: z.string().uuid(), total: z.number().int(), status: z.literal('processing') }) } } },
    503: quietHoursResponse,
  },
});

registry.registerPath({
  method: 'get', path: '/messages/send-bulk/{batchId}',
  summary: 'Poll bulk send progress',
  description: 'Returns current batch state. Poll until status is "complete". Batches are held for 24 hours after completion.',
  request: { params: z.object({ batchId: z.string().uuid() }) },
  responses: {
    200: { description: 'Batch state', content: { 'application/json': { schema: BulkBatchSchema } } },
    404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
  },
});

// ---------------------------------------------------------------------------
// Generate spec
// ---------------------------------------------------------------------------

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiSpec = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'fd-whatsapp-worker',
    version: '1.0.0',
    description: 'Transport-only WhatsApp Web API — sessions, messaging, and bulk sends.',
  },
  servers: [{ url: process.env.WHATSAPP_WORKER_URL ?? `http://localhost:${process.env.PORT ?? 3001}` }],
});
