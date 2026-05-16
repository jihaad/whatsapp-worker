# Worker TODO

What's left to ship on `whatsapp-worker`. Architecture, repo layout, and the deploy runbook live in `README.md` — this file is intentionally a focused punch list, not a design doc.

**Current state:** pure-API, transport-only, on `/v1`. Sessions (paginated), single + bulk messages (persisted, idempotent), liveness + readiness probes, Prometheus `/metrics`, OpenAPI at `/docs`, live operator dashboard at `/dashboard` (SSE event stream + DB-backed history). Standard error envelope across all non-2xx paths. Per-IP HTTP rate limit (600/min global, 30/min sends), `Cache-Control: no-store`, structured pino logging with request IDs. Anti-ban: 5–15s jitter, 07:00–21:00 EAT quiet hours, 5-min per-recipient cooldown, per-account token bucket (5 → 30 msg/min warmup), 100 msg/min global cap, typing indicator + read receipts, per-send trailing-whitespace body variation. Sessions persisted as tar.gz blobs in Postgres `whatsapp_sessions`; bulk batches in `whatsapp_bulk_batches`; per-message audit in `whatsapp_message_events`. systemd + Cloudflare Tunnel configs in `deploy/`.

**Not shipped yet:** HMAC auth. Below.

---

## 1. Auth — replace shared header with HMAC + service tokens

Today every request authenticates with the static `X-Worker-Secret` header (matches the consuming application's `WHATSAPP_WORKER_SECRET`). One leak rotates the whole system. Move to per-caller service tokens with HMAC-bound requests so a leaked token alone can't replay.

- [ ] `WORKER_SERVICE_TOKENS_JSON` env var — JSON array of `{ id, token, secret, scope }` rows. Worker loads + hashes secrets in memory at boot.
- [ ] Required request headers on every authenticated route:
  - `Authorization: Bearer <token>`
  - `X-Worker-Timestamp: <unix-seconds>` — reject if older than 60s or in the future by >10s
  - `X-Worker-Signature: <hex>` — `HMAC-SHA256(secret, "<method>\n<path>\n<timestamp>\n<sha256(body)>")`
- [ ] Scopes: `send`, `sessions`, `*` (admin). Token without the scope → 403.
- [ ] Client side: each consuming application implements the HMAC computation and includes the three headers on every authenticated call.
- [ ] Keep the legacy `X-Worker-Secret` header valid in parallel until clients have rotated, then remove.
- [ ] When per-token auth lands, swap `keyGenerator` in `src/lib/rate-limit.ts` from per-IP to `req.tokenId` so each caller gets its own bucket.

`/health`, `/health/ready`, `/docs`, `/metrics`, `/dashboard` stay public.

### Token rotation runbook
1. `openssl rand -hex 32` for token + secret.
2. Add new entry to `WORKER_SERVICE_TOKENS_JSON` (don't remove old yet).
3. `sudo systemctl restart whatsapp-worker`.
4. Update consuming application env vars; redeploy.
5. Verify a few sends with the new token.
6. Remove the old entry; restart again.

---

## 2. Out of scope

Things that have come up and been explicitly ruled out — leave them ruled out unless the architecture changes:

- **No internal queue.** The consuming application owns whatever durable queue / log it uses (e.g. a `notifications` table with a uniqueness constraint). `/v1/messages/send-bulk` is a thin paced-dispatch helper (persisted in `whatsapp_bulk_batches` for restart-survival + poll), not a replacement queue.
- **No multi-tenancy isolation.** One worker, one host. Sessions are keyed by an opaque UUID; the worker serves any caller it can authenticate but doesn't try to keep one caller's traffic from affecting another's (they share the global anti-ban cap, and the same WhatsApp account if you use only one phone).
- **No domain knowledge.** Only worker-owned tables in `prisma/schema.prisma`. The Prisma scope is the enforcement.
- **No HA.** Single host = single point of failure. WhatsApp Web sessions can't be HA — only one Chromium can hold a session at a time.
- **No WhatsApp Cloud API.** This worker is WhatsApp Web only. If you need Cloud API, run it from the consuming application directly.

---

## 3. References

**Worker — runtime**
- `src/index.ts` — express app wiring (pino-http, request-id, cache-control, auth, rate-limit, routers, signal handlers).
- `src/sessions.ts` — whatsapp-web.js lifecycle (init / restore / destroy / send) + messaging-layer limit calls.
- `src/database-auth.ts` — tar.gz session blobs ↔ Postgres `whatsapp_sessions`.
- `src/logger.ts` — pino logger with PII redaction and `LOG_LEVEL` toggle (pino-pretty in dev).
- `src/events.ts` — internal `EventEmitter`-based event bus consumed by `/events` SSE + persistence subscriber.

**Worker — `src/lib/`**
- `errors.ts` — `sendError()` + `ErrorResponseSchema`. Every non-2xx response uses this envelope.
- `idempotency.ts` — `Idempotency-Key` middleware (in-memory cache, 24h TTL, replay detection).
- `rate-limit.ts` — per-IP HTTP rate limiter (see §1 note about swapping the key strategy when HMAC lands).
- `messaging-limits.ts` — anti-ban suite (recipient cooldown, account/global token buckets, warmup curve).
- `body-variation.ts` — per-send trailing-whitespace body variation (`WHATSAPP_BODY_VARIATION` to toggle).
- `bulk-batch-maintenance.ts` — boot sweep (`processing` → `interrupted`) + 24h eviction of finished batches.
- `event-persistence.ts` — subscribes to the event bus and writes `message.*` / `bulk.*` to Postgres; 7-day retention.
- `anti-ban.ts` — jitter + quiet hours.

**Worker — schema**
- `prisma/schema.prisma` — `WhatsAppSession`, `WhatsAppBulkBatch`, `WhatsAppMessageEvent` models.
- `prisma/sql/*.sql` — canonical SQL migrations (apply via `prisma db execute`, not `db push`, so the worker's slim schema doesn't propose dropping tables the caller owns in the same database).
