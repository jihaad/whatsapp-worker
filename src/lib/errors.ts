import type { Request, Response } from 'express';
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// `.openapi()` is a method added to Zod by the OpenAPI extension. errors.ts
// is loaded before openapi.ts (via auth middleware → index.ts), so we extend
// here too. The call is idempotent — safe even when openapi.ts re-runs it.
extendZodWithOpenApi(z);

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'QUIET_HOURS'
  | 'SEND_FAILED'
  | 'INTERNAL'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENT_REQUEST_IN_PROGRESS'
  | 'RATE_LIMITED'
  // Messaging-layer anti-ban limits (distinct from HTTP RATE_LIMITED):
  | 'RECIPIENT_COOLDOWN'
  | 'ACCOUNT_RATE_LIMIT'
  | 'WARMUP_LIMIT'
  | 'GLOBAL_RATE_LIMIT'
  | 'ACCOUNT_SPACING'
  // Session's underlying WhatsApp Web socket is dead. Distinct from a
  // genuine "phone not on WhatsApp" lookup miss — the right caller
  // response is "retry later", not "the number is wrong".
  | 'SESSION_UNHEALTHY';

interface ErrorOptions {
  details?: unknown;
  retryAfter?: number;
}

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().openapi({ example: 'BAD_REQUEST', description: 'Machine-readable error code' }),
    message: z.string().openapi({ description: 'Human-readable explanation' }),
    requestId: z.string().openapi({ description: 'Request correlation ID; echoed in X-Request-Id header' }),
    details: z.unknown().optional().openapi({ description: 'Optional structured context (e.g. validation issues)' }),
    retryAfter: z.number().int().optional().openapi({ description: 'Seconds until the caller may retry (rate-limit / quiet-hours paths)' }),
  }),
});

export function sendError(
  req: Request,
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  opts: ErrorOptions = {},
): void {
  const requestId = String(req.id ?? '');
  res.setHeader('X-Request-Id', requestId);
  if (opts.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(opts.retryAfter));
  }
  res.status(status).json({
    error: {
      code,
      message,
      requestId,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
      ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}),
    },
  });
}
