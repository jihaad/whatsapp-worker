# whatsapp-worker

Pure-API WhatsApp Web worker. Transport-only: the worker exposes HTTPS
endpoints (link, status, send), owns its own `whatsapp_sessions` table, and
has **no domain knowledge** of the calling application. Any client app POSTs
to `/v1/messages/send` over HTTPS — the worker handles the WhatsApp Web
session, anti-ban pacing, and delivery.

> **Architecture:** the worker maintains its own Postgres tables
> (`whatsapp_sessions`, `whatsapp_bulk_batches`, `whatsapp_message_events`)
> in whichever Postgres you point `DIRECT_URL` at. The Prisma schema scope
> is the isolation boundary — only worker-owned tables are declared, so the
> worker can't accidentally query a consuming application's domain tables
> when they share a database. No internal queue: the calling app is the
> source of truth for what to send and when; the worker accepts an
> individual send or a `/messages/send-bulk` batch and paces delivery.

---

## Repo layout

```
.
├── package.json
├── tsconfig.json
├── prisma/
│   ├── schema.prisma          # vendored copy — see "Schema sync"
│   └── generated/client/      # output of `prisma generate` (gitignored)
├── prisma.config.ts           # Prisma 7 CLI config — feeds DIRECT_URL to migrate/generate
├── src/
│   ├── index.ts               # express app + signal handlers + boot
│   ├── sessions.ts            # whatsapp-web.js session lifecycle
│   ├── database-auth.ts       # LocalAuth tar.gz blob in/out of Postgres
│   ├── prisma.ts              # PrismaClient w/ pg adapter, session pooler
│   └── anti-ban.ts            # jitter + quiet-hours helpers
├── deploy/
│   ├── whatsapp-worker.service # systemd unit
│   └── cloudflared.config.yml  # Cloudflare Tunnel ingress
├── .env.example
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

- **Error envelope** (every non-2xx): `{ error: { code, message, requestId, details?, retryAfter? } }`. Codes: `BAD_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `QUIET_HOURS`, `SEND_FAILED`, `INTERNAL`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENT_REQUEST_IN_PROGRESS`, `RATE_LIMITED`, `RECIPIENT_COOLDOWN`, `ACCOUNT_RATE_LIMIT`, `WARMUP_LIMIT`, `GLOBAL_RATE_LIMIT`.
- **`X-Request-Id` response header** — set on every response; echoed in error envelopes for correlation with worker logs.
- **`Cache-Control: no-store`** — set on every response. QR codes, session status, and idempotency replays must never be cached.
- **HTTP rate limits**: 600 req/min global; tighter 30 req/min on send endpoints. 429 carries `Retry-After` and draft-7 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers.
- **Messaging-layer anti-ban** (inside `sendMessage()`): 5-min per-recipient cooldown, per-account token bucket with 7-day warmup curve (5 → 30 msg/min), 100 msg/min global cap. Each rejection surfaces as 429 with a distinct `error.code`.
- **Body variation** — the worker appends one of 8 invisible trailing-whitespace variants per send so 100 identical-input messages produce 100 byte-different outputs (`src/lib/body-variation.ts`). Recipients see no change; spam scorers see different fingerprints. Disable with `WHATSAPP_BODY_VARIATION=off`.
- **Idempotency replay** — when an `Idempotency-Key` matches a cached response, the worker sets `Idempotent-Replay: true` on the reply.

---

## Quick start (dev, on your laptop)

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

## Production deploy (single host · Ubuntu 22.04 LTS)

Pending work is tracked in [`TODO.md`](TODO.md). The summary below is the
operator's checklist for a fresh host. Replace `wa-worker` (the chosen
service / user name in these examples) with whatever you prefer — it's
just a convention.

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

# Laptop lid-close: don't suspend (if deploying on a laptop)
sudo sed -i 's/^#*HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo sed -i 's/^#*HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
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

### 5. systemd service

```bash
sudo cp deploy/whatsapp-worker.service /etc/systemd/system/whatsapp-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-worker
sudo journalctl -u whatsapp-worker -f     # tail logs
```

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

The worker owns its own schema (`prisma/schema.prisma`) — `WhatsAppSession`,
`WhatsAppBulkBatch`, `WhatsAppMessageEvent`. When the worker shares a
Postgres instance with another application, you have two choices:

1. **Independent schemas.** The worker's tables and the client's tables
   live side-by-side in the same database. Schema scope (the worker's
   Prisma file declares only worker tables) is the isolation boundary.
   Recommended.
2. **Shared schema.** If the client mirrors `WhatsAppSession` in its own
   Prisma schema (rare — usually the client just queries the worker's
   HTTP API), the two schemas must match column-for-column. Any change
   in one requires updating the other and running `npm run generate`
   here.

The worker uses Prisma 7 with the [`prisma.config.ts`](prisma.config.ts)
config (feeds `DIRECT_URL` to the CLI). Migrations go via
`prisma db execute --file ./prisma/sql/<name>.sql` because
`prisma db push` would propose dropping any table not in the worker's
schema — see [`prisma/sql/`](prisma/sql/) for canonical migrations.

---

## Operational runbook

### Worker is down

Symptoms: tunnel returns 502; `curl /health` times out; clients see
"WhatsApp not connected" everywhere.

```bash
ssh wa-worker@<host>
sudo systemctl status whatsapp-worker
sudo journalctl -u whatsapp-worker -n 200
sudo systemctl restart whatsapp-worker
sleep 30 && curl https://<your-hostname>/health
```

### Phone disconnected / WhatsApp banned

Symptoms: every send for one session returns `Session not ready` or
`Phone is not registered`.

1. From the client app, identify the affected session.
2. Have the operator re-link the phone (POST /v1/sessions/:sessionId,
   then scan the QR returned by the GET endpoint).
3. Once the worker reports `status: ready`, retry failed rows.

### Host rebooted / power loss

Both `whatsapp-worker` and `cloudflared` autostart via systemd. Sessions
auto-restore from `whatsapp_sessions` blobs (no fresh QR needed).

### Token rotation (every 90 days)

```bash
openssl rand -hex 32   # new shared secret

# Update both sides without removing the old yet — do the client first so
# any in-flight call doesn't fail mid-rotation, then rotate the worker.
# - This repo's .env  → set new value, restart
# - Client env vars   → swap to new value, redeploy

sudo systemctl restart whatsapp-worker
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
