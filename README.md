# whatsapp-worker

Pure-API WhatsApp Web worker. Transport-only: exposes versioned HTTPS endpoints (link, status, send, bulk), owns its own Postgres tables, paces delivery to stay clear of WhatsApp's bot detection, and ships with a built-in operator dashboard. Has **no domain knowledge** of the calling application — sessions are keyed by opaque UUIDs. Any client app POSTs to `/v1/messages/send` and the worker handles the WhatsApp Web session, anti-ban pacing, and delivery.

**At a glance:**
- **API:** `/v1/sessions/*` and `/v1/messages/*` over a single shared-secret header. OpenAPI spec at `/docs`. Standardised error envelope with request-IDs, idempotency keys on sends, HTTP rate limiting, and per-session liveness probing.
- **Anti-ban:** 5–15 s jitter, 07:00–21:00 EAT quiet hours, per-recipient cooldown, per-account token bucket with a 7-day warmup curve, global cap, typing-indicator + read-receipts, per-send byte-level body variation. Reinit-on-disconnect is hard-capped to 1 attempt per 15 min per session.
- **Operator dashboard** at `/dashboard`: three tabs (Messages / Network / Sessions) with live SSE event stream, 7-day history backfill from Postgres, and full session management — link new, reconnect dead, delete — without leaving the page.
- **Observability:** structured pino logs (PII-redacted), Prometheus `/metrics`, liveness + readiness probes, every request carries `X-Request-Id`.

> **Architecture:** the worker maintains its own Postgres tables (`whatsapp_sessions`, `whatsapp_bulk_batches`, `whatsapp_message_events`) in whichever Postgres you point `DIRECT_URL` at. The Prisma schema scope is the isolation boundary — only worker-owned tables are declared, so the worker can't accidentally query a consuming application's domain tables when they share a database. No internal queue: the calling app is the source of truth for what to send and when; the worker accepts an individual send or a `/v1/messages/send-bulk` batch and paces delivery.

---

## Repo layout

```
.
├── package.json
├── tsconfig.json
├── prisma/
│   ├── schema.prisma            # WhatsAppSession, WhatsAppBulkBatch, WhatsAppMessageEvent
│   ├── sql/                     # canonical SQL migrations (apply via `prisma db execute`)
│   └── generated/client/        # output of `prisma generate` (gitignored)
├── prisma.config.ts             # Prisma 7 CLI config — feeds DIRECT_URL
├── src/
│   ├── index.ts                 # express app wiring (pino-http, request-id, cache-control,
│   │                            # request-trace, auth, rate-limit, routers, signal handlers)
│   ├── sessions.ts              # whatsapp-web.js lifecycle: init/restore/destroy/send,
│   │                            # liveness probe + ban-safe debounced reinit
│   ├── database-auth.ts         # LocalAuth tar.gz blob in/out of Postgres
│   ├── prisma.ts                # PrismaClient w/ pg adapter, session pooler
│   ├── anti-ban.ts              # jitter + quiet hours
│   ├── events.ts                # EventEmitter bus → SSE + persistence
│   ├── logger.ts                # pino + redaction + LOG_LEVEL toggle
│   ├── metrics.ts               # Prometheus counters
│   ├── openapi.ts               # zod-to-openapi spec generation
│   ├── lib/
│   │   ├── errors.ts            # sendError() + ErrorResponseSchema (the envelope)
│   │   ├── idempotency.ts       # Idempotency-Key middleware (24h in-memory cache)
│   │   ├── rate-limit.ts        # per-IP HTTP rate limiter (express-rate-limit)
│   │   ├── messaging-limits.ts  # anti-ban suite (cooldown, account/global buckets, warmup)
│   │   ├── body-variation.ts    # per-send whitespace variation
│   │   ├── bulk-batch-maintenance.ts  # boot sweep + 24h eviction
│   │   ├── event-persistence.ts # subscribes to eventBus → whatsapp_message_events
│   │   └── session-watchdog.ts  # detect-only 5-min liveness sweep
│   ├── middleware/
│   │   ├── auth.ts              # X-Worker-Secret check (timing-safe)
│   │   ├── quiet-hours.ts       # 503 envelope for off-window sends
│   │   └── request-trace.ts     # captures req/res for the dashboard's Network panel
│   └── routes/
│       ├── health.ts            # /health + /health/ready
│       ├── docs.ts              # /docs (Scalar UI) + /docs/openapi.json
│       ├── sessions.ts          # /v1/sessions* CRUD
│       ├── messages.ts          # /v1/messages/send + /send-bulk + poll
│       ├── events.ts            # /events (SSE) + /events/recent (DB backfill)
│       └── dashboard.ts         # /dashboard (operator HTML — see "Dashboard")
├── deploy/
│   └── cloudflared.config.yml   # Cloudflare Tunnel ingress
├── .env.example
├── TODO.md
└── README.md
```

---

## API surface

All versioned endpoints sit under `/v1`. Auth via the shared
`X-Worker-Secret` header (matches the consuming application's
`WHATSAPP_WORKER_SECRET` env var). The infra endpoints (`/health`,
`/health/ready`, `/metrics`, `/docs`, `/dashboard`) are public and
unversioned. Live OpenAPI docs render at `/docs`; the raw spec is at
`/docs/openapi.json`.

| Method | Path | Notes |
|---|---|---|
| GET    | `/health` | Liveness — cheap, always 200 while the process is alive. For restart decisions. |
| GET    | `/health/ready` | Readiness — pings Prisma with a 2s timeout. 503 if the DB is unreachable. For "pull from rotation" decisions. |
| GET    | `/metrics` | Prometheus scrape (counters: messages sent / failed / bulk batches). |
| GET    | `/docs` | Scalar UI for the OpenAPI spec. |
| GET    | `/v1/sessions` | Paginated. Query: `?limit=1..200` (default 50), `?cursor=<opaque>`. Returns `{ sessions, nextCursor }`. |
| POST   | `/v1/sessions/:sessionId` | Initialise or return existing session. Returns `{ session }`. |
| GET    | `/v1/sessions/:sessionId` | Poll status + QR for one session. Returns `{ session }` (or `null`). |
| DELETE | `/v1/sessions/:sessionId` | Unlink + destroy. Returns `{ sessionId }`. |
| POST   | `/v1/messages/send` | Body `{ sessionId, recipient, body }`. Quiet-hours guard (503), 5–15s jitter, then sends. Synchronous. 200 → `{ messageId, recipientPhone, timestamp }`. Optional `Idempotency-Key` header (8–200 chars) makes retries safe — cached for 24h. |
| POST   | `/v1/messages/send-bulk` | Body `{ sessionId, messages: [{ recipient, body }] }` (1–500). Returns 202 + `{ batchId }`; sends run in the background, paced by anti-ban jitter. Persisted across restarts. Honors `Idempotency-Key`. |
| GET    | `/v1/messages/send-bulk/:batchId` | Poll a bulk batch. Status: `processing` / `complete` / `interrupted`. Held for 24h after completion. |

### Cross-cutting contract

- **Error envelope** (every non-2xx): `{ error: { code, message, requestId, details?, retryAfter? } }`. Codes: `BAD_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `QUIET_HOURS`, `SEND_FAILED`, `INTERNAL`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENT_REQUEST_IN_PROGRESS`, `RATE_LIMITED`, `RECIPIENT_COOLDOWN`, `ACCOUNT_RATE_LIMIT`, `WARMUP_LIMIT`, `GLOBAL_RATE_LIMIT`, `SESSION_UNHEALTHY`.
- **`X-Request-Id` response header** — set on every response; echoed in error envelopes for correlation with worker logs.
- **`Cache-Control: no-store`** — set on every response. QR codes, session status, and idempotency replays must never be cached.
- **HTTP rate limits**: 600 req/min global; tighter 30 req/min on send endpoints. 429 carries `Retry-After` and draft-7 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers.
- **Messaging-layer anti-ban** (inside `sendMessage()`): 5-min per-recipient cooldown, per-account token bucket with 7-day warmup curve (5 → 30 msg/min), 100 msg/min global cap. Each rejection surfaces as 429 with a distinct `error.code`. Typing indicator + read receipts also enabled.
- **Body variation** — the worker appends one of 8 invisible trailing-whitespace variants per send so 100 identical-input messages produce 100 byte-different outputs (`src/lib/body-variation.ts`). Recipients see no change; spam scorers see different fingerprints. Disable with `WHATSAPP_BODY_VARIATION=off`.
- **Idempotency replay** — when an `Idempotency-Key` matches a cached response, the worker sets `Idempotent-Replay: true` on the reply.
- **Session health** — every send runs a cached `getState()` liveness probe (5s cache, 1.5s timeout). If the WhatsApp Web socket is dead, the send returns **503 `SESSION_UNHEALTHY`** with `retryAfter` and kicks a debounced reinit (15-min hard cooldown for ban safety; in-flight lock; bypassed only by explicit operator action via POST `/v1/sessions/:sessionId` on a `disconnected` session). A passive watchdog sweeps every 5 min and flips dead sessions to `disconnected` so the dashboard reflects reality. `GET /v1/sessions/:sessionId` also runs a cached live probe so its `status` field never lies.
- **Structured pino logs** — JSON in prod, pino-pretty in dev. PII redacted at the logger (`recipient`, `phoneNumber`, `body`, auth headers). `LOG_LEVEL` env var controls verbosity.

---

## Dashboard

`GET /dashboard` serves a single-page operator console (no build step, Tailwind via CDN). Public HTML; the page prompts for the worker secret on first load and stores it in `sessionStorage`. All API calls from the page carry `X-Worker-Secret` + `X-Dashboard-Internal: 1` so they don't pollute the Network panel by default.

Three tabs in the header:

- **Messages** — live event feed of every `message.sent` / `message.failed` / `bulk.started` / `bulk.completed`. Filter by status (All / Sent / Failed / Bulk) and by linked phone number. Per-event row shows recipient (last-4 masked by default — toggle in the header to reveal), message body (for debugging), latency, and request IDs. Backfills from `whatsapp_message_events` (7-day DB retention) + localStorage cache so reloads don't show a blank feed. Stat strip: Sent, Failed, Success rate, Throughput (rolling 60s).
- **Network** — every authenticated HTTP request captured by [src/middleware/request-trace.ts](src/middleware/request-trace.ts) with status, method, path, latency, full request/response headers + bodies (capped at 4 KB, sensitive headers redacted). Click any row to expand. Filter by 2xx / 4xx / 5xx and toggle visibility of internal (dashboard-originated) traffic.
- **Sessions** — full session management. List of cards with status pill (`ready` / `qr_pending` / `connecting` / `disconnected`), short UUID, masked phone, last activity. Click to expand → QR code (if `qr_pending`), full last-activity timestamp, and three actions: **⟳ Refresh**, **⤴ Reconnect** (shown when `disconnected` — triggers a forced reinit on the server; bypasses the 15-min auto-cooldown for explicit operator intent), **Delete** (with confirm). **+ New session** at the top opens a modal that auto-generates a UUID, POSTs to create, and polls until the QR appears, then until `ready`. Lives updates from the server's SSE stream — no manual refresh needed.

Auth-gated streaming endpoint `GET /events` (SSE) is what powers the live updates; `GET /events/recent` is the 7-day backfill query.

---

## Quick start (dev)

```bash
git clone git@github.com:jihaad/whatsapp-worker.git
cd whatsapp-worker
npm install
npm run generate              # builds prisma/generated/client/
cp .env.example .env          # fill in DIRECT_URL + WHATSAPP_WORKER_SECRET
npm run dev                   # tsx watch — restarts on save
```

`http://127.0.0.1:3001/health` (or whatever you set `WHATSAPP_WORKER_URL` to) should return `{ ok: true, uptime: <seconds> }`.

---

## Production deploy (Lenovo ThinkCentre M900 Tiny · 4 GB · Ubuntu 22.04 LTS)

Pending work is tracked in [`TODO.md`](TODO.md). The summary below is the
operator's checklist for the production host — a Lenovo ThinkCentre M900
Tiny (Intel i3/i5, 4 GB RAM, single-host, worker supervised by pm2,
public ingress via Cloudflare Tunnel, deploys via GitHub Actions over
Tailscale). Replace `wa-worker` (the chosen service /
user name in these examples) with whatever you prefer — it's just a
convention.

**Sizing on 4 GB:** plan for ~5 linked WhatsApp sessions comfortably, 7–8
max. Each Chromium-backed session uses 300–500 MB steady-state; the OS +
worker process take another ~500–700 MB. Add 2 GB of swap as a safety net
(see step 1) and bump the file-descriptor limit (each Chromium burns
through them).

### 1. Base OS hardening

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl git build-essential ufw unattended-upgrades

# Dedicated low-privilege user
sudo useradd -m -s /bin/bash wa-worker
sudo mkdir -p /var/lib/wa-worker /var/log/wa-worker
sudo chown -R wa-worker:wa-worker /var/lib/wa-worker /var/log/wa-worker

# SSH keys-only
sudo sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# Firewall: deny incoming, allow ssh only
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow ssh && sudo ufw enable

# Auto-updates
sudo dpkg-reconfigure -plow unattended-upgrades

# Add 2GB of swap as a safety net for Chromium peaks (cold boot, history
# sync after a re-link). Without it, an OOM-kill nukes a session mid-message.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Bump nofile limit — Chromium burns through file descriptors fast at 5+
# sessions. systemd's default 1024 will start failing under load.
sudo tee /etc/security/limits.d/wa-worker.conf >/dev/null <<'EOF'
*  soft  nofile  65535
*  hard  nofile  65535
EOF
```

### 2. Chromium (Ubuntu 22.04 gotcha)

`apt install chromium-browser` on 22.04 redirects to a snap that breaks
Puppeteer's sandbox. Pick **one** of:

```bash
# Option A (recommended): Google Chrome stable .deb
wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y /tmp/chrome.deb
# Then in .env: PUPPETEER_EXECUTABLE_PATH=/opt/google/chrome/google-chrome

# Option B: let Puppeteer download its bundled Chromium
sudo -u wa-worker -i npx puppeteer browsers install chrome
# Leave PUPPETEER_EXECUTABLE_PATH unset
```

### 3. Node 22 LTS via NodeSource

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should print v22.x
```

### 4. Clone + install

```bash
sudo -u wa-worker -i git clone git@github.com:jihaad/whatsapp-worker.git /home/wa-worker/app
cd /home/wa-worker/app
sudo -u wa-worker -i npm install
sudo -u wa-worker -i npm run generate
sudo -u wa-worker -i cp .env.example .env
sudo -u wa-worker -i nano .env       # fill in real values
sudo chmod 600 /home/wa-worker/app/.env
```

### 5. Process supervisor (pm2)

```bash
# Install pm2 globally as the worker user
sudo -u wa-worker -i npm install -g pm2

# Start the worker under pm2 and persist across reboots
sudo -u wa-worker -i pm2 start npm --name whatsapp-worker -- start
sudo -u wa-worker -i pm2 save
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u wa-worker --hp /home/wa-worker

# Tail logs
sudo -u wa-worker -i pm2 logs whatsapp-worker
```

The GitHub Actions deploy workflow (`.github/workflows/deploy.yml`) SSHes
in over Tailscale and runs `deploy.sh`, which pulls the latest commit,
installs deps, regenerates the Prisma client, and runs `pm2 restart
whatsapp-worker`.

### 6. Cloudflare Tunnel

```bash
curl -L --output /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb

sudo cloudflared tunnel login
sudo cloudflared tunnel create wa-worker
sudo cloudflared tunnel route dns wa-worker worker.example.com   # your hostname

sudo cp deploy/cloudflared.config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml   # replace <tunnel-id> with the real UUID
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Verify from anywhere: `curl https://<your-hostname>/health` returns the
public health JSON.

### 7. Client env vars

In the consuming application:

```
WHATSAPP_WORKER_URL=https://<your-hostname>
WHATSAPP_WORKER_SECRET=<same value as worker .env>
```

Redeploy the client. Link a session and trigger a send — the message
should arrive in WhatsApp.

---

## Schema sync

The worker owns three tables in [`prisma/schema.prisma`](prisma/schema.prisma):

- `WhatsAppSession` — one row per linked phone; `sessionData` is the tar.gz auth blob.
- `WhatsAppBulkBatch` — bulk send batches; persisted so polls survive a worker restart.
- `WhatsAppMessageEvent` — append-only event log; backs the dashboard's history feed (7-day retention).

If the worker shares a Postgres instance with another application:

1. **Independent schemas (recommended).** Worker tables and client tables live side-by-side; schema scope (the worker's Prisma file declares only worker tables) is the isolation boundary.
2. **Mirrored schema.** If the client app *also* declares any of these tables in its own Prisma schema (e.g. to stop its `db push` from dropping them), both sides must match column-for-column. **No `@relation` to the consuming app's tables** — a foreign key forces the client's `db push` to recreate it on every sync, which breaks the worker's fresh-link flow with a P2003 constraint violation. The pre-built [prisma/sql/drop_session_fk.sql](prisma/sql/drop_session_fk.sql) recovers if it happens.

The worker uses Prisma 7 with the [`prisma.config.ts`](prisma.config.ts) config (feeds `DIRECT_URL` to the CLI). Migrations go via `prisma db execute --file ./prisma/sql/<name>.sql` because `prisma db push` would propose dropping any table not in the worker's schema. See [`prisma/sql/`](prisma/sql/) for the canonical migration files.

**Long-term:** [`TODO.md`](TODO.md) §2 moves the worker to its own Supabase project, which makes the mirroring problem disappear entirely. §3 renames the legacy `schoolId` column to `sessionId` to match the rest of the project-agnostic codebase.

---

## Operational runbook

### Worker is down

Symptoms: tunnel returns 502; `curl /health` times out; clients see
"WhatsApp not connected" everywhere.

```bash
ssh wa-worker@<host>
pm2 status
pm2 logs whatsapp-worker --lines 200 --nostream
pm2 restart whatsapp-worker
sleep 30 && curl https://<your-hostname>/health
```

### Session shows `disconnected`

The worker auto-detects dead sockets via the send-path liveness probe, the 5-min watchdog, or the live-state check on `GET /v1/sessions/:sessionId`. When that happens, sends return **503 `SESSION_UNHEALTHY`** instead of the misleading "not registered".

To recover (no worker restart needed):

1. Open `/dashboard` → **Sessions** tab.
2. Find the card showing `disconnected`. Click to expand.
3. Click **⤴ Reconnect**. The dashboard POSTs `/v1/sessions/:sessionId`; the server runs a forced reinit (skips the 15-min auto-cooldown — explicit operator intent — but keeps the in-flight lock so spamming the button doesn't spawn multiple Chromiums).
4. Wait 5–60 s. The card flips to `ready` (auth blob still valid → no re-scan needed) or `qr_pending` (blob rejected → expand the card to see the new QR and scan it from the phone).

### Phone banned by WhatsApp

If the linked phone number is genuinely banned (not just a dead socket), no reinit will recover it — the operator needs to use a different number. Delete the session from the dashboard and create a new one with a fresh phone.

### Host rebooted / power loss

pm2 (via its `pm2 startup` systemd hook) and `cloudflared` both autostart
on boot. Sessions auto-restore from `whatsapp_sessions` blobs (no fresh
QR needed).

### Token rotation (every 90 days)

```bash
openssl rand -hex 32   # new shared secret

# Update both sides without removing the old yet — do the client first so
# any in-flight call doesn't fail mid-rotation, then rotate the worker.
# - This repo's .env  → set new value, restart
# - Client env vars   → swap to new value, redeploy

pm2 restart whatsapp-worker
```

---

## What this worker does not do

- **No WhatsApp Cloud API.** Only WhatsApp Web (via whatsapp-web.js +
  headless Chromium). If you need Cloud API, run it from your client app
  directly — it doesn't need this worker.
- **No queue.** The consuming app owns whatever notification log / queue
  it has, iterates due rows, and POSTs each to `/v1/messages/send` (or
  submits a `/v1/messages/send-bulk` batch). The worker is stateless
  per-message apart from session state, jitter, and the anti-ban limits.
- **No multi-tenancy isolation.** One worker process, one host. Sessions
  are keyed by an opaque `sessionId` UUID — the worker happily serves
  multiple `sessionId`s in parallel, but they share the same anti-ban
  global cap and the same WhatsApp account if you use only one phone.
- **No HTTP egress beyond the Cloudflare Tunnel + Postgres.** UFW blocks
  everything else by default. Don't add outbound calls without thinking
  about it.

---

## License

Proprietary.
