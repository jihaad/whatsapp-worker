# Worker TODO

What's left to ship on `whatsapp-worker`. Architecture, repo layout, and the deploy runbook live in `README.md` — this file is intentionally a focused punch list, not a design doc.

**Current state:** pure-API, transport-only, on `/v1`. Sessions (paginated, live-updated over SSE), single + bulk messages (persisted, idempotent, upfront session-health-checked), liveness + readiness probes, Prometheus `/metrics`, OpenAPI at `/docs`, live operator dashboard at `/dashboard` with Messages / Network / Sessions tabs (SSE event stream + DB-backed history + in-tab session management). Standard error envelope across all non-2xx paths. Per-IP HTTP rate limit (600/min global, 30/min sends), `Cache-Control: no-store`, structured pino logging with request IDs. Anti-ban: 5–15s jitter, 07:00–21:00 EAT quiet hours, 5-min per-recipient cooldown, per-account token bucket (5 → 30 msg/min warmup), 100 msg/min global cap, typing indicator + read receipts, per-send trailing-whitespace body variation. Session-health: pre-send `getState()` liveness probe, debounced 15-min reinit cooldown (ban-safe), watchdog sweep every 5 min, `SESSION_UNHEALTHY` 503 envelope, init-failed-on-restore self-heal. Sessions persisted as tar.gz blobs in Postgres `whatsapp_sessions`; bulk batches in `whatsapp_bulk_batches`; per-message audit in `whatsapp_message_events`. pm2-managed (via systemd-hooked pm2 startup); public ingress via Cloudflare Tunnel (`deploy/cloudflared.config.yml`); CI deploys over Tailscale (`.github/workflows/deploy.yml`).

**Not shipped yet:** HMAC auth, isolating the worker's Postgres into its own Supabase project, and renaming the `schoolId` column / variables to `sessionId` to match the project-agnostic stance. Below in priority order.

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

## 2. Separate Supabase project — isolate worker storage

The worker currently shares a Supabase project with the consuming application. That's a layering violation: a compromised worker secret reaches the caller's tables, and the worker's Prisma schema has to omit those tables (which is why `prisma db push` would propose dropping every other table — we use `prisma db execute --file` as a workaround). Worse, the caller's `prisma db push` keeps re-adding the `whatsapp_sessions_schoolId_fkey` foreign key, which breaks fresh links until we drop it again ([prisma/sql/drop_session_fk.sql](prisma/sql/drop_session_fk.sql)). Give the worker its own Supabase project so the only thing in that DB is what `prisma/schema.prisma` declares.

- [ ] Provision a new Supabase project — worker-only. Note `DIRECT_URL` (port 5432, session pooler) for the connection string.
- [ ] Run `prisma/sql/*.sql` against the new project via `prisma db execute` to materialise the schema. (Once isolated, `prisma db push` becomes safe — but keep the SQL files as the canonical record.)
- [ ] Migrate live data — small dataset, single transaction is fine:
  - `pg_dump --data-only --table=whatsapp_sessions --table=whatsapp_bulk_batches --table=whatsapp_message_events <old DIRECT_URL>`
  - `psql <new DIRECT_URL> < dump.sql`
  - Verify row counts match on both sides before switching.
- [ ] Update worker `.env`: `DIRECT_URL` (and optional `WORKER_DATABASE_URL`) point at the new project. Restart the worker; confirm session restore works and `/health/ready` reports `db: ok`.
- [ ] Drop the worker's tables from the old shared project once the new one has been running cleanly for ~24 h. Document the cutover in the consuming application's runbook.
- [ ] Once isolated, drop the "schema-sync" framing in `prisma/schema.prisma` — the worker now owns its DB outright and doesn't need to mention the consuming application's schema at all.

**Why this matters:** blast-radius reduction (a leaked worker secret can't reach the caller's data), independent schema evolution, independent Postgres upgrades, simpler ops (`prisma db push` works), no more recurring FK violations, and clearer audit boundaries.

---

## 3. Drop legacy `schoolId` — rename to `sessionId` everywhere

The worker is project-agnostic — `schoolId` is a vestige of the original use case and contradicts the rest of the codebase, which already says "treat it as an opaque tenant UUID" in every comment. Rename it once so internal names match the external HTTP contract (`POST /v1/sessions/:sessionId` already uses `sessionId`).

**Best done together with §2 (separate Supabase) so the column rename is a single coordinated migration.** Doing it before §2 requires updating the consuming application's mirror schema in lockstep, which is the same kind of cross-app drift §2 exists to eliminate.

### DB

- [ ] Write a SQL migration ([prisma/sql/rename_session_id.sql](prisma/sql/rename_session_id.sql)): `ALTER TABLE whatsapp_sessions RENAME COLUMN "schoolId" TO "sessionId";` plus any FK / index name updates. Apply via `prisma db execute`.
- [ ] Update [prisma/schema.prisma](prisma/schema.prisma) — `WhatsAppSession.schoolId` → `sessionId`. Same change in any consuming-app mirror schema **until §2 ships**.

### Worker code

- [ ] [src/sessions.ts](src/sessions.ts) — `schoolId` → `sessionId` in every signature: `initSession`, `getSession`, `destroySession`, `sendMessage`, internal `ManagedSession` references, `sessions: Map<...>` key, `initializing: Set<...>`, log child contexts, event payloads (`session.*` events already publish `sessionId`, but internal helpers use `schoolId`).
- [ ] [src/database-auth.ts](src/database-auth.ts) — `DatabaseAuth` constructor still takes `clientId`; internal `this.schoolId` field renames to `this.sessionId`. All Prisma calls go from `where: { schoolId }` to `where: { sessionId }`.
- [ ] [src/lib/messaging-limits.ts](src/lib/messaging-limits.ts) — `forgetAccount(schoolId)` / `consumeRateTokens(schoolId)` → rename param. DB read `prisma.whatsAppSession.findUnique({ where: { schoolId } })` updates.
- [ ] [src/lib/bulk-batch-maintenance.ts](src/lib/bulk-batch-maintenance.ts) — no `schoolId` directly but verify after the dust settles.
- [ ] [src/sessions.ts:listSessions](src/sessions.ts) and `toSchoolSession` — the result type `SchoolSession` should also rename (e.g. to `WorkerSession`); the route already serialises `sessionId` so external callers are unaffected.
- [ ] [src/routes/](src/routes/) — replace any `schoolId` locals with `sessionId`. HTTP path params (`:sessionId`) are already correct.

### Verification

- [ ] `grep -rn schoolId src/` returns zero hits.
- [ ] `npx tsc --noEmit` clean.
- [ ] Restart the worker, link a fresh session via the dashboard, send a test message, confirm the session row persists with the new column name.
- [ ] If §2 hasn't shipped yet: run the same migration against the consuming application's DB and update its mirror schema in lockstep.

---

## 4. Out of scope

Things that have come up and been explicitly ruled out — leave them ruled out unless the architecture changes:

- **No internal queue.** The consuming application owns whatever durable queue / log it uses (e.g. a `notifications` table with a uniqueness constraint). `/v1/messages/send-bulk` is a thin paced-dispatch helper (persisted in `whatsapp_bulk_batches` for restart-survival + poll), not a replacement queue.
- **No multi-tenancy isolation.** One worker, one host. Sessions are keyed by an opaque UUID; the worker serves any caller it can authenticate but doesn't try to keep one caller's traffic from affecting another's (they share the global anti-ban cap, and the same WhatsApp account if you use only one phone).
- **No domain knowledge.** Only worker-owned tables in `prisma/schema.prisma`. The Prisma scope is the enforcement.
- **No HA.** Single host = single point of failure. WhatsApp Web sessions can't be HA — only one Chromium can hold a session at a time.
- **No WhatsApp Cloud API.** This worker is WhatsApp Web only. If you need Cloud API, run it from the consuming application directly.
- **No watchdog auto-reinit.** The session watchdog is detect-only (flips status to `disconnected`, emits an event). Reinit only fires when a real send arrives for a dead session, and is hard-capped at one attempt per 15 minutes per session — passive auto-reconnect loops are how phones get banned.

---

## 5. References

**Worker — runtime**
- `src/index.ts` — express app wiring (pino-http, request-id, cache-control, request-trace, auth, rate-limit, routers, signal handlers).
- `src/sessions.ts` — whatsapp-web.js lifecycle (init / restore / destroy / send), messaging-layer limit calls, `checkLive` + `reinitializeSessionDebounced` ban-safe self-heal.
- `src/database-auth.ts` — tar.gz session blobs ↔ Postgres `whatsapp_sessions`.
- `src/logger.ts` — pino logger with PII redaction and `LOG_LEVEL` toggle (pino-pretty in dev).
- `src/events.ts` — internal `EventEmitter`-based event bus consumed by `/events` SSE + persistence subscriber.

**Worker — `src/lib/`**
- `errors.ts` — `sendError()` + `ErrorResponseSchema`. Every non-2xx response uses this envelope.
- `idempotency.ts` — `Idempotency-Key` middleware (in-memory cache, 24h TTL, replay detection).
- `rate-limit.ts` — per-IP HTTP rate limiter (swap key strategy to `req.tokenId` when §1 lands).
- `messaging-limits.ts` — anti-ban suite (recipient cooldown, account/global token buckets, warmup curve).
- `body-variation.ts` — per-send trailing-whitespace body variation (`WHATSAPP_BODY_VARIATION` to toggle).
- `bulk-batch-maintenance.ts` — boot sweep (`processing` → `interrupted`) + 24h eviction of finished batches.
- `event-persistence.ts` — subscribes to the event bus and writes `message.*` / `bulk.*` to Postgres; 7-day retention.
- `session-watchdog.ts` — detect-only 5-min sweep, flips dead `ready` sessions to `disconnected`.
- `anti-ban.ts` — jitter + quiet hours.

**Worker — middleware (`src/middleware/`)**
- `auth.ts` — `X-Worker-Secret` check with timing-safe compare; public path allowlist.
- `quiet-hours.ts` — 503 envelope for sends outside the configured window.
- `request-trace.ts` — captures req/res for the dashboard's Network panel; redacts secrets.

**Worker — schema**
- `prisma/schema.prisma` — `WhatsAppSession`, `WhatsAppBulkBatch`, `WhatsAppMessageEvent` models.
- `prisma/sql/*.sql` — canonical SQL migrations (apply via `prisma db execute`, not `db push`, so the worker's slim schema doesn't propose dropping tables the caller owns in the same database).
</content>
</invoke>