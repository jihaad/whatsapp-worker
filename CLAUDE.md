# Claude context — whatsapp-worker

Quick orientation for AI agents picking up this repo. Skim before doing anything; the docs are denser ([README.md](README.md), [TODO.md](TODO.md)).

## What this is

Pure-API WhatsApp Web worker on Node 22 + Express + TypeScript. Pretends to be a phone connected to WhatsApp Web (via `whatsapp-web.js` + headless Chromium / Puppeteer) and exposes `POST /v1/messages/send` over HTTPS for any caller to deliver messages. No domain knowledge — sessions are opaque UUIDs.

Versioned API surface lives under `/v1`. Operator dashboard (Messages / Network / Sessions tabs, live SSE) at `/dashboard`. OpenAPI spec at `/docs`. Prometheus metrics at `/metrics`. Liveness/readiness probes at `/health` and `/health/ready`.

## How it's deployed

- **Host:** Lenovo ThinkCentre M900 Tiny (Intel i3/i5, 12 GB RAM), Ubuntu 22.04 LTS. Single host, no HA — only one Chromium can hold a WA Web session at a time.
- **Process supervisor:** pm2 (with `pm2 startup systemd` for autostart). Not raw systemd — the systemd unit in `deploy/` was removed.
- **Public ingress:** Cloudflare Tunnel → `worker.fududeey-waxbarasho.com` → `127.0.0.1:3001` (or `0.0.0.0:3001` if LAN access is wanted; check the prod `.env`).
- **Private access:** Tailscale mesh VPN for SSH (ops Mac + GitHub Actions deploy runner). UFW blocks all other inbound.
- **CI:** `.github/workflows/deploy.yml` runs on push to `main`, SSHes over Tailscale, runs `deploy.sh` which pulls, npm-installs, regenerates Prisma client, and `pm2 restart whatsapp-worker`.
- **DB:** Worker has its **own** dedicated Supabase project (post the May 2026 separation). Mac dev points at a separate test DB (currently the old shared project where FD also lives). Connection via the **session pooler** (port 5432), never the transaction pooler.

## Hard invariants (these hurt to relearn)

1. **Never run two workers against the same Supabase project.** Both restore from the same `whatsapp_sessions.sessionData` blobs at boot → both claim to be the same WhatsApp Web device → WA's server bumps one offline → silent message loss (sends look "successful" with valid messageIds but never deliver). This is the #1 cause of "shows sent but didn't arrive" bugs. Check with `pgrep -fa "tsx watch src/index.ts"` and `lsof -i:3001` on the dev machine.
2. **`client.sendMessage()` returning a messageId proves nothing about delivery.** whatsapp-web.js generates the id client-side before any server ack. The real signal is the message's `ack` field (-1 error, 0 pending, 1 server-received, 2 device-received, 3 read). The worker doesn't currently wait for ack ≥ 1 — that's a known gap; see TODO.
3. **`client.getState()` only reads the SPA's state machine, not the wire.** A wedged session can still report `CONNECTED`. Use this knowledge before "fixing" the watchdog or liveness probe — they look correct but don't catch protocol-level drift.
4. **Reinit is hard-capped at 1 attempt per 15 min per session.** WhatsApp ratelimits re-link attempts; passive auto-reconnect loops are how the linked phone gets banned. The watchdog is **detect-only** by design; only the send path triggers reinit, with a cooldown. Don't relax this.
5. **The `whatsapp_sessions.sessionId` column** was renamed from `schoolId` in May 2026. If you see `schoolId` anywhere in code, it's a regression — old name, dead reference. (FD's mirror schema was updated in lockstep.)
6. **Anti-ban gates can be bypassed with `X-Worker-Override: 1`** (or `{ "override": true }` in body). Use sparingly — logs at warn level, surfaces with ⚠ OVERRIDE pill in the dashboard. Real ban risk if abused.

## Where things live

```
src/
  index.ts          Express wiring (pino-http, request-trace, auth, rate-limit, routers)
  sessions.ts      whatsapp-web.js lifecycle + checkLive() + reinitializeSessionDebounced()
  database-auth.ts tar.gz session blobs ↔ Postgres
  events.ts        EventEmitter bus (message.*, session.*, bulk.*, http.request)
  logger.ts        pino + PII redaction + pino-pretty in dev
  openapi.ts       Zod schemas + OpenAPI spec generation
  metrics.ts       Prometheus counters
  prisma.ts        PrismaClient singleton (DIRECT_URL only — WORKER_DATABASE_URL removed)
  lib/
    errors.ts            sendError() + envelope (every non-2xx uses this shape)
    idempotency.ts       Idempotency-Key middleware (24h in-memory)
    rate-limit.ts        per-IP HTTP rate limit (express-rate-limit)
    messaging-limits.ts  anti-ban: per-recipient cooldown, account/global token buckets, warmup
    body-variation.ts    per-send trailing-whitespace variation
    bulk-batch-maintenance.ts  boot sweep + 24h eviction
    event-persistence.ts subscribes eventBus → whatsapp_message_events
    session-watchdog.ts  detect-only 5-min sweep
    override.ts          X-Worker-Override header / body field check
  middleware/
    auth.ts          X-Worker-Secret check (timing-safe)
    quiet-hours.ts   503 envelope for off-window sends (respects override)
    request-trace.ts captures req/res for dashboard's Network panel
  routes/
    health.ts         /health + /health/ready
    docs.ts           /docs (Scalar UI) + /docs/openapi.json
    sessions.ts       /v1/sessions* CRUD
    messages.ts       /v1/messages/send + /send-bulk + poll
    events.ts         /events SSE + /events/recent backfill
    dashboard.ts      /dashboard (operator HTML, no build step)
    favicon.ts        /favicon.{svg,ico} (shared WhatsApp glyph)

prisma/
  schema.prisma  WhatsAppSession (sessionId), WhatsAppBulkBatch, WhatsAppMessageEvent
  sql/           canonical SQL migrations (apply via `prisma db execute`, not `db push` if sharing a DB)

deploy/
  cloudflared.config.yml   Cloudflare Tunnel ingress

.github/workflows/
  deploy.yml     CI deploy: Tailscale auth → SSH → deploy.sh on the host
deploy.sh        runs on TinyPC: git pull, npm install, prisma generate, pm2 restart
```

## Open work

See [TODO.md](TODO.md). One item left:

1. **HMAC auth** — replace the shared `X-Worker-Secret` with per-caller service tokens signed by HMAC-SHA256 over method + path + timestamp + body hash. Includes scope-checks (`send`, `sessions`, `*`). When this lands, the rate limiter's `keyGenerator` should switch from per-IP to `req.tokenId` for accurate per-caller throttling.

Everything else listed in earlier TODOs (versioning, error envelope, idempotency, pagination, rate limits, anti-ban suite, dashboard, separate Supabase, schoolId rename) has already shipped.

## Common commands

```bash
npm run dev          # tsx watch — local dev (uses .env, points at dev DB)
npm run start        # tsx (no watch)
npm run generate     # prisma generate

npx tsc --noEmit     # type-check (no build artifacts)
npx prisma db push --url '...'      # CLI-overridable schema push
npx prisma db execute --file ...    # raw SQL migration (no --url flag)
```

Worker on TinyPC (SSH via Tailscale):

```bash
sudo -u worker -i pm2 status
sudo -u worker -i pm2 logs whatsapp-worker
sudo -u worker -i pm2 restart whatsapp-worker
```

## Working with the user

- They're a hands-on operator + developer; prefer terse direct answers, not long preambles.
- Has explicitly asked: **do not commit or push anything unless they say so**. Edit files freely; hold git operations until told.
- When a question is "how does X work?", show the relevant file:line and a 2–3 sentence summary, not a five-paragraph essay.
- "Override" the anti-ban gates is a legitimate operational need (see `src/lib/override.ts`). Don't add friction to using it.
- Multi-session deployments are deliberate — they run 2+ WhatsApp accounts off one worker. Don't accidentally optimise for the single-session case.
