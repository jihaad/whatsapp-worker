# Worker TODO

What's left to ship on `fd-whatsapp-worker`. Architecture, repo layout, and the deploy runbook live in `README.md` — this file is intentionally a focused punch list, not a design doc.

**Current state:** pure-API, transport-only. `/health`, `/sessions`, `/sessions/:schoolId` (POST/GET/DELETE), `/messages/send` are live. Anti-ban shipped: 5–15s jitter + 07:00–21:00 EAT quiet hours (`src/anti-ban.ts`). Sessions persisted as tar.gz blobs in Postgres `whatsapp_sessions`. systemd + Cloudflare Tunnel configs in `deploy/`.

**Not shipped yet:** HMAC auth, the rest of the rate-limit suite, and the Ubuntu host itself. Below in priority order.

---

## 1. Auth — replace shared header with HMAC + service tokens

Today every request authenticates with the static `X-Worker-Secret` header (matches FD's `WHATSAPP_WORKER_SECRET`). One leak rotates the whole system. Move to per-caller service tokens with HMAC-bound requests so a leaked token alone can't replay.

- [ ] `WORKER_SERVICE_TOKENS_JSON` env var — JSON array of `{ id, token, secret, scope }` rows. Worker loads + hashes secrets in memory at boot.
- [ ] Required request headers on every authenticated route:
  - `Authorization: Bearer <token>`
  - `X-FD-Timestamp: <unix-seconds>` — reject if older than 60s or in the future by >10s
  - `X-FD-Signature: <hex>` — `HMAC-SHA256(secret, "<method>\n<path>\n<timestamp>\n<sha256(body)>")`
- [ ] Scopes: `send`, `sessions`, `*` (admin). Token without the scope → 403.
- [ ] FD-side: extend `src/lib/whatsapp-worker/client.ts` to compute the HMAC. Add `WORKER_SERVICE_TOKEN` + `WORKER_SERVICE_SECRET` to Vercel env.
- [ ] Keep the legacy `X-Worker-Secret` header valid in parallel until FD has rotated, then remove.

`/health` stays public — no auth, used by the tunnel and uptime probes.

### Token rotation runbook
1. `openssl rand -hex 32` for token + secret.
2. Add new entry to `WORKER_SERVICE_TOKENS_JSON` (don't remove old yet).
3. `sudo systemctl restart fd-worker`.
4. Update Vercel env vars; redeploy.
5. Verify a few sends with the new token.
6. Remove the old entry; restart again.

---

## 2. Rate limits — finish the suite

Two of seven layers shipped (jitter + quiet hours). The rest protect the linked phone from a Meta ban when something goes wrong upstream — runaway cron, accidental bulk send, compromised FD token.

| Layer | Default | Status | Storage |
|---|---|---|---|
| Inter-message jitter | 5–15s | ✅ shipped (`src/anti-ban.ts`) | n/a |
| Quiet hours | 07:00–21:00 EAT | ✅ shipped (`src/anti-ban.ts`) | n/a |
| Per-account per-minute | 30 msg/min | ⏳ pending | in-memory token bucket |
| Per-account per-day | 500 msg/day | ⏳ pending | Supabase counter, resets 00:00 EAT |
| Per-recipient cooldown | 5 min | ⏳ pending | in-memory LRU |
| Account warm-up | 50 → 500 over 7 days | ⏳ pending | derived from `whatsapp_sessions.createdAt` |
| Global per-minute | 100 msg/min | ⏳ pending | in-memory token bucket |

- [ ] **Per-recipient cooldown** — LRU map of `recipient → lastSentAt`. Reject with `RECIPIENT_COOLDOWN` 429 + `Retry-After`. Cheapest win against the "two reminders inside a minute" foot-gun.
- [ ] **Daily quota** — single Supabase table (or column on `whatsapp_sessions`) keyed by `(schoolId, eatDate)`. Counter resets at 00:00 Africa/Nairobi. Persisted (not in-memory) so a worker crash can't reset the cap. Reject with `DAILY_QUOTA_EXCEEDED` 429.
- [ ] **Per-minute + global token buckets** — use [`bottleneck`](https://www.npmjs.com/package/bottleneck) (one instance per `schoolId` + one global). `npm view bottleneck version` first.
- [ ] **Account warm-up curve** — read `whatsapp_sessions.createdAt`; clamp the daily quota lower for the first 7 days (e.g. day 1: 50, day 2: 100, day 3: 200, day 7: 500).
- [ ] **Message text variation** — rotate trailing salutations / emoji so consecutive sends aren't byte-identical. Cheapest hedge against aggregate spam-flagging. Two ways: (a) FD's `notification_templates` carries a list, FD picks at random, worker is stateless; (b) worker appends one of N invisible variations. Prefer (a) — keeps the worker dumb.
- [ ] **Read receipts + typing indicator** — call `chat.sendSeen()` on incoming + `chat.sendStateTyping()` for ~1–2s before each `sendMessage()`. Both feed WAHA's engagement score. ~50 LOC inside `src/sessions.ts`.
- [ ] Every 429 response includes `Retry-After` (seconds) and `X-RateLimit-*` headers so FD's cron can back off cleanly.

---

## 3. Idempotency — light, FD owns it

FD already enforces idempotency via `notification_logs` unique constraints on `(invoiceId, trigger, period)`. The worker doesn't need its own SQLite store.

- [ ] Optional: accept `idempotencyKey` in `/messages/send` and short-circuit duplicates seen in the last 24h. In-memory `Map<key, result>` with a sliding window is fine — quota is small and a crash losing the window is acceptable (FD's unique constraint is the safety net).

Skip this if §1 + §2 are done and we're not seeing dup sends in the activity log.

---

## 4. Host deployment — ThinkPad X250t · Ubuntu 22.04 LTS

The README has the full step-by-step. This is the operator's checklist.

- [ ] Ubuntu 22.04 LTS Server install + `fdworker` user + UFW + SSH keys-only + unattended-upgrades.
- [ ] Lid-close override: `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf`.
- [ ] Chromium — Google Chrome `.deb` (recommended) **or** Puppeteer-bundled. **Don't** `apt install chromium-browser` on 22.04 (snap, breaks sandbox).
- [ ] Node 22 LTS via NodeSource (Ubuntu 22.04's default Node is too old).
- [ ] Clone repo + `npm install` + `npm run generate` + `.env` (mode 600).
- [ ] systemd: `sudo cp deploy/fd-worker.service /etc/systemd/system/` → `daemon-reload` → `enable --now`.
- [ ] Log rotation under `/etc/logrotate.d/fd-worker` (daily, 14-day retention, copytruncate).
- [ ] Cloudflare Tunnel: install `cloudflared`, `tunnel login`, `tunnel create fd-worker`, `tunnel route dns fd-worker worker.fududeeye.so`, copy `deploy/cloudflared.config.yml` to `/etc/cloudflared/`, replace `<tunnel-id>` with the real UUID, `cloudflared service install`.
- [ ] Cloudflare Access: Application = `worker.fududeeye.so`, Path = `/api/*` (leave `/health` open), Service Auth policy with one service token per FD environment.
- [ ] FD-side env in Vercel: `WHATSAPP_WORKER_URL=https://worker.fududeeye.so`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, plus the §1 worker-side token + secret. Or set the worker URL through FD's `/super-admin/settings` UI (it persists in `platform_settings.whatsappWorkerUrl`).
- [ ] Smoke tests from a Vercel deploy: link a school → QR scan → status `ready` → trigger one send → message arrives → `whatsapp_sessions` row reflects last activity.

---

## 5. Docker deployment — laptop, 24/7

Run the worker and Cloudflare Tunnel as Docker containers so the whole stack starts automatically on boot and restarts itself if it crashes — no Node, no cloudflared, no systemd service to manage manually on the host.

### Prerequisites (one-time, on the laptop)
- [ ] Install Docker Engine (not Docker Desktop): `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`
- [ ] Lid-close override so the laptop doesn't sleep when shut: add `HandleLidSwitch=ignore` to `/etc/systemd/logind.conf`, then `sudo systemctl restart systemd-logind`.
- [ ] Disable suspend on power button and idle: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`
- [ ] Keep it plugged in — UPS or surge protector recommended.

### Write the Dockerfile
- [ ] Create `Dockerfile` in the repo root. Base on `node:22-bookworm-slim`. Install Google Chrome stable from the official `.deb` (not `apt install chromium-browser` — that's a snap and breaks Puppeteer). Set `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable` and `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`. Copy source, run `npm ci --omit=dev && npm run generate`, expose port 3001.

### Write docker-compose.yml
- [ ] Create `docker-compose.yml` with two services:
  - **worker** — builds from the Dockerfile, `restart: unless-stopped`, mounts `.env` as env_file, mounts named volumes for session data (`.wwebjs_auth`) and cache (`.wwebjs_cache`) so QR scans survive container restarts, adds `--cap-add=SYS_ADMIN` (required for Chromium sandbox inside Docker) or keep `--no-sandbox` and drop the cap.
  - **tunnel** — `image: cloudflare/cloudflared:latest`, `restart: unless-stopped`, command: `tunnel --url http://worker:3001` (uses the internal Docker network — no localhost needed), depends_on: worker.

### Start it
```bash
docker compose up -d          # start both containers in background
docker compose logs -f        # watch live logs from both
docker compose restart worker # restart just the worker after a code change
```

### Auto-start on boot
- [ ] Enable Docker to start on boot: `sudo systemctl enable docker` (done automatically by the get.docker.com script).
- [ ] `docker compose up -d` on boot is automatic because `restart: unless-stopped` brings containers back up when the Docker daemon starts.
- [ ] Optionally add a systemd unit that runs `docker compose up -d` from the repo directory on boot, in case the laptop was hard-powered-off while containers were stopped.

### Updating the worker
```bash
git pull
docker compose build worker
docker compose up -d --no-deps worker   # zero-downtime swap (tunnel stays up)
```

---

## 6. Observability

- [ ] Stable log prefixes already in use (`[wa-worker]`, `[wa-session:<id>]`); make sure every catch in `src/sessions.ts` and `src/index.ts` includes one.
- [ ] `/health` returns `{ ok, uptime, version, sessions: [{ schoolId, status, lastActivity }] }` — gate the session list behind auth (don't leak phone numbers / school IDs publicly). Two health endpoints (`/health` minimal public, `/health/detail` authenticated) is fine.
- [ ] Cloudflare dashboard → Tunnels → `fd-worker` already gives 24h traffic + status; bookmark it.
- [ ] FD's `/super-admin/activity` is the cross-cutting view (every send writes a `whatsapp.sent` / `whatsapp.failed` activity row from FD's side).

---

## 7. Out of scope

Things that have come up and been explicitly ruled out — leave them ruled out unless the architecture changes:

- **No internal queue.** FD owns `notification_logs`. FD's cron iterates due rows and POSTs each to `/messages/send`. The worker is stateless per-message apart from session + jitter state.
- **No `/messages/send-bulk`.** Bulk pacing belongs in FD's cron loop. Adding it here would re-introduce the queue we just deleted.
- **No multi-tenancy.** One worker, one host, one FD instance. Don't bake tenant IDs into the API surface.
- **No FD domain knowledge.** No tables beyond `whatsapp_sessions`. The Prisma schema scope is the enforcement.
- **No HA.** One ThinkPad is the SPOF. WhatsApp Web sessions can't be HA — only one Chromium can hold a session at a time.
- **No WhatsApp Cloud API.** That path runs serverless inside FD; it doesn't touch this worker.

---

## 8. References

- `README.md` — repo layout, API surface, deploy runbook, schema-sync workflow.
- `src/anti-ban.ts` — jitter + quiet hours.
- `src/sessions.ts` — whatsapp-web.js lifecycle (init / restore / destroy / send).
- `src/database-auth.ts` — tar.gz session blobs ↔ Postgres.
- FD repo `TODO.md` §2 — FD-side counterpart (cron rewire, doc updates).
- FD repo `src/lib/whatsapp-worker/{client,session-status}.ts` — HTTP client + cached read helpers.
- FD repo `src/lib/platform-settings.ts` — admin-editable worker URL (`resolveWorkerUrl`).