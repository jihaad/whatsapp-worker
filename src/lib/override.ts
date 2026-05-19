import type { Request } from 'express';

/**
 * Two ways to opt in to the anti-ban bypass on a single send:
 *
 *   - Header: `X-Worker-Override: 1` (preferred for ergonomic curl /
 *     operational use cases — doesn't pollute the message body)
 *   - Body field: `{ "override": true }` (parsed by the route handlers
 *     via SendMessageBodySchema / SendBulkBodySchema)
 *
 * Both paths funnel through `hasOverride()` so the bypass decision is
 * uniform across middleware (quiet-hours, rate-limit) and the route handler
 * (recipient cooldown, account/global buckets, jitter).
 *
 * The header check happens against the raw req.headers and so works in
 * middleware that runs before request body parsing or schema validation;
 * the body check covers callers that prefer keeping the override in JSON.
 *
 * Anything truthy on the header — '1', 'true', 'yes', or just any non-empty
 * non-'0' string — is treated as "on". The body must be literal `true`.
 *
 * **Both call sites are auth-gated by the regular X-Worker-Secret check;
 * `hasOverride()` does not relax authentication.**
 */
export function hasOverride(req: Request): boolean {
  const raw = req.headers['x-worker-override'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string') {
    const v = header.trim().toLowerCase();
    if (v && v !== '0' && v !== 'false' && v !== 'no') return true;
  }
  // Body field — only set after express.json + zod parse runs, but
  // middleware that calls this *before* the body parse (none currently)
  // would simply see false. Routes set req.body via the validated parsed
  // object.
  const body = req.body as { override?: unknown } | undefined;
  return body?.override === true;
}
