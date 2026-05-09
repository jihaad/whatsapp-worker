# fd-whatsapp-worker

Pure-API WhatsApp Web worker for **Fududeeye Waxbarasho**. Transport-only:
the worker exposes HTTPS endpoints (link, status, send), owns its own
`whatsapp_sessions` table, and has **no knowledge of FD's domain models**
(schools, students, classes, invoices, payments). FD calls this worker
over HTTPS for everything WhatsApp-related.

> **Architecture:** the worker reads + writes one Postgres table
> (`whatsapp_sessions`) in the **same Supabase project as FD**. Isolation
> is enforced by the worker's Prisma schema scope — only `WhatsAppSession`
> is declared, so the worker can't accidentally query FD tables. No
> internal queue: FD's Vercel Cron iterates due reminders and POSTs each
> one to `/messages/send`.

---

## Repo layout

```
.
├── package.json
├── tsconfig.json
├── prisma/
│   ├── schema.prisma          # vendored copy — see "Schema sync"
│   └── generated/client/      # output of `prisma generate` (gitignored)
├── src/
│   ├── index.ts               # express app + signal handlers + boot
│   ├── sessions.ts            # whatsapp-web.js session lifecycle
│   ├── database-auth.ts       # LocalAuth tar.gz blob in/out of Postgres
│   ├── prisma.ts              # PrismaClient w/ pg adapter, session pooler
│   └── anti-ban.ts            # jitter + quiet-hours helpers
├── deploy/
│   ├── fd-worker.service      # systemd unit
│   └── cloudflared.config.yml # Cloudflare Tunnel ingress
├── .env.example
└── README.md
```

---

## API surface

All endpoints under `https://<your-tunnel>/`. Auth via the shared
`X-Worker-Secret` header (matches FD's `WHATSAPP_WORKER_SECRET` env var).
`/health` is public for tunnel + uptime probes.

| Method | Path | Body / Notes |
|---|---|---|
| GET  | `/health` | Public. Returns `{ ok: true, uptime }`. |
| GET  | `/sessions` | Lists every session (live + saved-only). FD reads this for dashboards/sidebars. |
| POST | `/sessions/:schoolId` | Initialise / get current session. Returns `{ session: { schoolId, status, qrDataUrl, phoneNumber, lastActivity } }`. |
| GET  | `/sessions/:schoolId` | Poll status + QR for one session. Same shape. |
| DELETE | `/sessions/:schoolId` | Unlink + destroy. Removes the row. |
| POST | `/messages/send` | Body `{ schoolId, recipient, body }`. Applies quiet-hours guard (503 + `Retry-After`) and 5–15s jitter, then sends. Synchronous; ~5–15s typical latency. |

`POST /sessions/:schoolId/send` is kept as a legacy alias while FD's
`whatsapp-worker/client.ts` migrates from the old per-session send path
to the unified `/messages/send`. Delete once the FD-side migration is in.

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

`http://localhost:3001/health` should return `{ ok: true, uptime: <seconds> }`.

---

## Production deploy (ThinkPad X250t · Ubuntu 22.04 LTS)

Pending work (auth, rate limits, host bring-up) is tracked in
[`TODO.md`](TODO.md). The summary below is the operator's checklist for
a fresh host.

### 1. Base OS hardening

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl git build-essential ufw unattended-upgrades

# Dedicated low-privilege user
sudo useradd -m -s /bin/bash fdworker
sudo mkdir -p /var/lib/fd-worker /var/log/fd-worker
sudo chown -R fdworker:fdworker /var/lib/fd-worker /var/log/fd-worker

# SSH keys-only
sudo sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# Firewall: deny incoming, allow ssh only
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow ssh && sudo ufw enable

# Auto-updates
sudo dpkg-reconfigure -plow unattended-upgrades

# Laptop lid-close: don't suspend
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
sudo -u fdworker -i npx puppeteer browsers install chrome
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
sudo -u fdworker -i git clone git@github.com:jihaad/whatsapp-worker.git /home/fdworker/app
cd /home/fdworker/app
sudo -u fdworker -i npm install
sudo -u fdworker -i npm run generate
sudo -u fdworker -i cp .env.example .env
sudo -u fdworker -i nano .env       # fill in real values
sudo chmod 600 /home/fdworker/app/.env
```

### 5. systemd service

```bash
sudo cp deploy/fd-worker.service /etc/systemd/system/fd-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now fd-worker
sudo journalctl -u fd-worker -f     # tail logs
```

### 6. Cloudflare Tunnel

```bash
curl -L --output /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb

sudo cloudflared tunnel login
sudo cloudflared tunnel create fd-worker
sudo cloudflared tunnel route dns fd-worker worker.fududeeye.so

sudo cp deploy/cloudflared.config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml   # replace <tunnel-id> with the real UUID
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Verify from anywhere: `curl https://worker.fududeeye.so/health` returns
the public health JSON.

### 7. FD-side env vars

In FD's Vercel project:

```
WHATSAPP_WORKER_URL=https://worker.fududeeye.so
WHATSAPP_WORKER_SECRET=<same value as worker .env>
```

Redeploy. From `/super-admin/notifications/queue`, link a school and
trigger a send — the message should arrive in WhatsApp.

---

## Schema sync

The schema is defined in **`fududeey-waxbarasho`** (the FD repo) at
`prisma/schema.prisma` for the `WhatsAppSession` model. This repo holds
a vendored copy. The two must match column-for-column.

Workflow on every FD schema change that touches `WhatsAppSession`:

1. Apply the change in FD with `npx prisma migrate dev --name <descriptive>`.
2. Copy the model block into `prisma/schema.prisma` in this repo
   (preserve the worker's `output = "./generated/client"` generator line —
   FD's points elsewhere).
3. `npm run generate` — confirms TypeScript still compiles.
4. Commit + push. The systemd-managed worker on the ThinkPad picks up
   on next deploy.

Most schema changes in FD won't touch `WhatsAppSession` and don't need
this dance.

---

## Operational runbook

### Worker is down

Symptoms: tunnel returns 502; `curl /health` times out; FD UI shows
"WhatsApp not connected" everywhere.

```bash
ssh fdworker@<host>
sudo systemctl status fd-worker
sudo journalctl -u fd-worker -n 200
sudo systemctl restart fd-worker
sleep 30 && curl http://127.0.0.1:3001/health
```

### Phone disconnected / WhatsApp banned

Symptoms: every send for one school returns `Session not ready` or
`Phone is not registered`.

1. From FD's `/super-admin/notifications/queue`, filter by school.
2. Have the school re-link their phone via `/notifications` → "Link Phone".
3. Once the worker reports `status: ready`, retry failed rows.

### Host rebooted / power loss

Both `fd-worker` and `cloudflared` autostart via systemd. Sessions
auto-restore from `whatsapp_sessions` blobs (no fresh QR needed).

### Token rotation (every 90 days)

```bash
openssl rand -hex 32   # new shared secret

# Update both sides without removing the old yet — do FD first so any
# in-flight call doesn't fail mid-rotation, then rotate the worker.
# - This repo's .env  → set new value, restart
# - Vercel env vars   → swap to new value, redeploy

sudo systemctl restart fd-worker
```

---

## Anti-ban posture

- **Randomised inter-message jitter** — 5–15s wait inside `POST /messages/send`
  before whatsapp-web.js dispatches.
- **Quiet hours** — sends rejected with HTTP 503 + `Retry-After` outside
  07:00–21:00 EAT.
- **Re-entrant transient handlers** — Puppeteer's "Execution context was
  destroyed" / "Target closed" errors are caught and logged, not crashy.

Pending (see [`TODO.md`](TODO.md) §2):

- Per-recipient cooldown (LRU)
- Daily quota (resets 00:00 EAT)
- Account warm-up curve
- Message text variation
- Read receipts + typing indicator

---

## What this worker does not do

- **No WhatsApp Cloud API.** That path lives in the FD Vercel app
  (`src/lib/whatsapp/`) and runs serverless — it doesn't need this worker.
- **No queue.** FD owns the `notification_logs` queue. FD's cron iterates
  due rows and POSTs each to `/messages/send`. The worker is stateless
  per-message (apart from session state + jitter).
- **No multi-tenancy.** One worker, one host, one FD instance.
- **No HTTP egress beyond the Cloudflare Tunnel + Postgres.** UFW blocks
  everything else. Don't add outbound calls without thinking about it.

---

## License

Proprietary — Fududeeye Waxbarasho internal infrastructure.
