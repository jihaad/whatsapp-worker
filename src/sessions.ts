import { Client } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import { DatabaseAuth } from './database-auth';
import { prisma } from './prisma';
import { logger } from './logger';
import { eventBus, type WorkerEvent } from './events';
import { checkRecipientCooldown, consumeRateTokens, recordRecipientSend, forgetAccount, checkAccountSpacing, recordAccountSend, type LimitCode } from './lib/messaging-limits';
import { varyBody } from './lib/body-variation';
import { alertSessionProblem } from './lib/operator-alerts';
import { ackLabel } from './lib/ack';

/**
 * Long-lived session manager for the WhatsApp worker process.
 *
 * The worker is the **transport layer** — it knows about WhatsApp Web
 * sessions keyed by an opaque UUID (`sessionId` in code for historical
 * reasons; treat it as an arbitrary tenant identifier). No knowledge of
 * the calling application's domain models. Callers track linked status
 * for their own UI by polling the worker's HTTP API.
 *
 * Session blobs persist in `whatsapp_sessions.sessionData` as tar.gz —
 * Chromium restores from the DB on worker startup without requiring a new
 * QR scan. Status is held in-memory only.
 */

export type SessionStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'ready';

export interface WorkerSession {
  sessionId: string;
  status: SessionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  lastActivity: string;
  // ISO timestamp of when the session most recently entered `ready` state.
  // Null whenever status !== 'ready'. Lets the dashboard show
  // "connected for Xm Ys" without storing extra state client-side.
  readySince: string | null;
}

export interface SendMessageResult {
  success: boolean;
  messageId: string | null;
  recipientPhone: string;
  error?: string;
  timestamp: string;
  // Populated when the send was blocked by a messaging-layer rate limit
  // (recipient cooldown, per-account / global / warmup). The route handler
  // checks for this and maps to HTTP 429 with the standard error envelope.
  rateLimit?: { code: LimitCode; retryAfter: number };
  // Populated when the WhatsApp Web socket is dead (or unresponsive). The
  // route handler maps to HTTP 503 SESSION_UNHEALTHY. Distinct from
  // "phone not on WhatsApp" so the caller knows to retry, not to fix the
  // recipient.
  sessionUnhealthy?: { state: string; retryAfter: number };
}

interface ManagedSession {
  client: Client;
  auth: DatabaseAuth;
  status: SessionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  lastActivity: string;
  // ISO timestamp of when the session most recently flipped to `ready`.
  // Cleared whenever status leaves `ready` (disconnect, auth failure,
  // liveness-probe flip). The dashboard shows "connected for Xm Ys" using
  // this so operators can see at a glance how stable a session has been.
  readySince: string | null;
  // ms-timestamp of the last live getState() result. Used to skip the
  // Puppeteer round-trip on hot send paths if we checked very recently.
  lastStateCheck?: number;
  // ms-timestamp of the last reinit attempt. Combined with REINIT_COOLDOWN_MS
  // to hard-cap reinit frequency — WhatsApp ratelimits re-link attempts and
  // a loose loop here would expose the linked phone to bans.
  lastReinitAt?: number;
  // True while a reinit is running. Other reinit requests during this
  // window are no-ops to avoid concurrent destroy/init races.
  reinitInFlight?: boolean;
  // ms-timestamp of when status most recently became `connecting`. Used by
  // the watchdog to detect a session wedged in `connecting` — one where WA
  // Web never fired a terminal (ready/qr/disconnected) event. Set on every
  // entry into `connecting`; only read while status === 'connecting'.
  connectingSince?: number;
}

const sessions = new Map<string, ManagedSession>();

/**
 * sessionIds whose initSession() is currently in-flight (Chromium launching).
 * getSession() returns `connecting` for these so clients keep polling.
 */
const initializing = new Set<string>();

function getSessionDir(): string {
  return process.env.WHATSAPP_SESSION_DIR ?? '.wwebjs_auth';
}

/**
 * On worker restart after a crash, Chromium may have left a SingletonLock
 * behind (the process was killed before it could clean up). Since the worker
 * is a single long-lived process, a lock file always means a stale crash —
 * just delete it and retry.
 */
async function tryInitialize(client: Client, sessionId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.initialize();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';

      if (msg.includes('Execution context was destroyed')) {
        // WhatsApp Web navigated mid-inject — transient, retry after a short wait.
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw err;
      }

      if (msg.includes('browser is already running')) {
        // Crash-restart case: old Chromium is dead, lock files are stale.
        const { rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const sessionDir = join(getSessionDir(), `session-${sessionId}`);
        await rm(join(sessionDir, 'SingletonLock'), { force: true }).catch(() => {});
        await rm(join(sessionDir, 'DevToolsActivePort'), { force: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      throw err;
    }
  }
}

/**
 * `isRestore` — true when called from restoreSessions() on worker boot. A QR
 * event fired on a restore means WhatsApp rejected the saved auth blob (usual
 * cause: snapshot taken mid-LevelDB-write, or the device was revoked from the
 * phone). In that case we drop the dead DB row so the next restart doesn't
 * keep retrying the bad blob.
 */
export async function initSession(sessionId: string, isRestore = false): Promise<WorkerSession> {
  const existing = sessions.get(sessionId);
  if (existing) {
    // If the caller is asking for a session that's currently disconnected,
    // treat the POST as "please reconnect this dead session". Trigger a
    // forced reinit (skips the 15min auto-cooldown — explicit caller
    // intent). The in-flight lock still prevents concurrent attempts.
    // Returns the current (still-disconnected) snapshot immediately; the
    // caller polls GET /v1/sessions/:id and sees status flip to
    // `connecting` → `ready` (or `qr_pending` if the blob is rejected).
    if (existing.status === 'disconnected') {
      logger.child({ sessionId }).info('initSession on disconnected session — kicking forced reinit');
      reinitializeSessionDebounced(sessionId, { force: true });
    }
    return toWorkerSession(sessionId, existing);
  }

  eventBus.publish('session.init', {
    sessionId: sessionId, isRestore,
    status: 'connecting', phoneNumber: null, qrDataUrl: null, lastActivity: new Date().toISOString(),
  });
  const log = logger.child({ sessionId });
  const auth = new DatabaseAuth({ clientId: sessionId, dataPath: getSessionDir() });
  const initStart = Date.now();
  const client = new Client({
    authStrategy: auth,
    // Cache the WhatsApp Web HTML/JS bundle on disk. Without this, every
    // fresh session re-downloads ~1 MB from web.whatsapp.com before the QR
    // can be emitted — that was the bulk of the 20s cold-boot wait.
    webVersionCache: { type: 'local', path: process.env.WHATSAPP_CACHE_DIR ?? '.wwebjs_cache' },
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
      ],
      // --single-process / --no-zygote are deliberately omitted. They force
      // Chromium to render the WhatsApp Web SPA in one process, which on
      // macOS adds ~10s to QR emission. Only re-enable in constrained
      // containers that can't spawn child processes.
    },
  });

  const managed: ManagedSession = {
    client, auth,
    status: 'connecting',
    qrDataUrl: null,
    phoneNumber: null,
    lastActivity: new Date().toISOString(),
    readySince: null,
    connectingSince: Date.now(),
  };
  sessions.set(sessionId, managed);

  // Fires once per initSession lifecycle — used to detect a failed restore
  // (QR event after we extracted a saved blob = blob is dead).
  let qrSeen = false;

  client.on('qr', async (qr: string) => {
    try {
      managed.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      managed.status = 'qr_pending';
      managed.lastActivity = new Date().toISOString();
      log.info({ elapsedMs: Date.now() - initStart }, 'qr ready');
      eventBus.publish('session.qr', {
        sessionId: sessionId, elapsedMs: Date.now() - initStart,
        status: 'qr_pending', qrDataUrl: managed.qrDataUrl, phoneNumber: managed.phoneNumber, lastActivity: managed.lastActivity,
      });

      if (isRestore && !qrSeen) {
        qrSeen = true;
        log.warn('restore rejected by WhatsApp — dropping stale blob');
        await prisma.whatsAppSession.delete({ where: { sessionId } }).catch(() => {});
        alertSessionProblem(sessionId, 'restore_rejected', 'WhatsApp rejected the saved login on restart — a fresh QR scan is needed');
      }
    } catch {
      managed.qrDataUrl = null;
    }
  });

  client.on('ready', async () => {
    managed.status = 'ready';
    managed.qrDataUrl = null;
    managed.readySince = new Date().toISOString();
    managed.lastActivity = new Date().toISOString();
    const info = client.info;
    if (info?.wid?.user) managed.phoneNumber = info.wid.user;
    log.info({ phoneNumber: managed.phoneNumber }, 'session ready');
    eventBus.publish('session.ready', {
      sessionId: sessionId, phoneNumber: managed.phoneNumber,
      status: 'ready', qrDataUrl: null, lastActivity: managed.lastActivity,
      readySince: managed.readySince,
    });

    // Wait for Chromium to flush IndexedDB to disk before taring the session.
    // 20s gives the initial WhatsApp history sync room to land before we
    // snapshot — a tar taken mid-LevelDB-compaction restores to a profile
    // that WhatsApp refuses on the next boot and emits a fresh QR for. This
    // is the crash-fallback path; clean shutdown re-persists from a fully
    // settled Chromium (see persistAndDestroyAll below).
    await new Promise((r) => setTimeout(r, 20000));

    await auth.persistToDatabase(managed.phoneNumber ?? undefined).catch((err) => {
      // P2003 = Postgres foreign-key violation. The worker's whatsapp_sessions
      // table picks one up whenever the consuming application's Prisma schema
      // declares a WhatsAppSession with `@relation`, then runs `db push`. Drop
      // it via prisma/sql/drop_session_fk.sql; the durable fix is to isolate
      // the worker's DB (TODO §3) so cross-schema corruption can't happen.
      const code = (err as { code?: string }).code;
      const meta = (err as { meta?: { driverAdapterError?: { cause?: { constraint?: { index?: string } } } } }).meta;
      const constraint = meta?.driverAdapterError?.cause?.constraint?.index;
      if (code === 'P2003') {
        log.error(
          { code, constraint },
          'persist on ready failed — FK violation on whatsapp_sessions. Session is functional in memory but will NOT survive restart. Drop the FK with: npx prisma db execute --file ./prisma/sql/drop_session_fk.sql. Long-term: TODO §3 (isolate worker DB).',
        );
        return;
      }
      log.error({ err }, 'persist on ready failed');
    });
  });

  client.on('authenticated', () => {
    log.info('authenticated');
    eventBus.publish('session.authenticated', {
      sessionId: sessionId,
      status: 'connecting', phoneNumber: managed.phoneNumber, qrDataUrl: null, lastActivity: managed.lastActivity,
    });
    managed.status = 'connecting';
    managed.connectingSince = Date.now();
    managed.lastActivity = new Date().toISOString();
  });

  client.on('loading_screen', (pct: number, msg: string) => {
    log.debug({ pct, msg }, 'loading');
  });

  client.on('disconnected', (reason) => {
    log.info({ reason }, 'session disconnected');
    eventBus.publish('session.disconnected', {
      sessionId: sessionId, reason: String(reason),
      status: 'disconnected', phoneNumber: managed.phoneNumber, qrDataUrl: null, lastActivity: managed.lastActivity,
    });
    managed.status = 'disconnected';
    managed.qrDataUrl = null;
    managed.readySince = null;
    managed.lastActivity = new Date().toISOString();
    // Deliberately NOT calling sessions.delete(sessionId) here. The watchdog
    // sweeps disconnected entries and attempts reinit (debounced — 15 min
    // cooldown applies), so a brief network blip self-heals: first sweep
    // after connectivity returns triggers reinit, and tryInitialize will
    // either succeed or remove the entry on persistent failure.
    // Auth-failure stays a hard delete (separate handler below) — same blob
    // won't recover.
  });

  // Best-effort read receipts. WhatsApp engagement scoring rewards accounts
  // whose user actually reads incoming messages — silent inboxes look bot-y.
  // Non-fatal: any failure here is logged at debug and the worker continues.
  client.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      await chat.sendSeen();
    } catch (err) {
      log.debug({ err }, 'sendSeen failed (non-fatal)');
    }
  });

  // Outbound delivery/read receipts. whatsapp-web.js fires message_ack as the
  // recipient's device confirms our sent messages: ack climbs -1→0→1→2→3(→4).
  // We only care about our own (fromMe) messages — inbound acks are noise. The
  // messageId here matches what sendMessage returned (msg.id.id), so callers
  // can correlate. Covers single AND bulk sends — acks are per-message off the
  // client, independent of how the message was queued.
  client.on('message_ack', (msg, ack: number) => {
    if (!msg.fromMe) return;
    eventBus.publish('message.ack', {
      sessionId,
      recipient: typeof msg.to === 'string' ? msg.to.replace(/@c\.us$/, '') : null,
      messageId: msg.id?.id ?? null,
      ack,
      ackLabel: ackLabel(ack),
    });
  });

  client.on('auth_failure', (msg) => {
    log.error({ msg }, 'auth failure');
    alertSessionProblem(sessionId, 'auth_failure', String(msg));
    eventBus.publish('session.auth_failure', {
      sessionId: sessionId, reason: String(msg),
      status: 'disconnected', phoneNumber: managed.phoneNumber, qrDataUrl: null, lastActivity: managed.lastActivity,
    });
    managed.status = 'disconnected';
    managed.qrDataUrl = null;
    managed.readySince = null;
    sessions.delete(sessionId);
  });

  // Kick Chromium off in the background. Awaiting client.initialize() here
  // adds ~10s of dead spinner time on the client before the QR even has a
  // chance to appear — the UI already polls getSession() every 2s, so we
  // just return the `connecting` session immediately and let the poll pick
  // up the QR the moment it's emitted.
  tryInitialize(client, sessionId).catch((err) => {
    log.error({ err }, 'init failed');
    sessions.delete(sessionId);
    client.destroy().catch(() => {});
    // Deliberately do NOT drop the DB row on a restore-path init failure.
    // Earlier attempts at that self-heal were too aggressive: any transient
    // failure (Chromium contention on cold boot, exhausted "Execution
    // context destroyed" retries, slow disk) would wipe a perfectly valid
    // saved blob, and we'd lose sessions across restarts.
    // The genuine "WhatsApp rejected the blob" case is handled separately
    // by the QR-on-restore branch above: when WA Web rejects the auth it
    // emits a QR, and we drop the row there. That's the only signal we
    // can trust. Anything else here is "try again next restart".
  });

  return toWorkerSession(sessionId, managed);
}

/**
 * Restore all previously-linked sessions on worker startup.
 * Fires each initSession() in the background so the worker HTTP server
 * is available immediately while Chromium boots in the background.
 *
 * **Pure-API note:** the worker has no cross-table knowledge of the
 * calling application's domain. It trusts `whatsapp_sessions` as the
 * source of truth for what to restore. Callers are responsible for
 * issuing `DELETE /v1/sessions/:sessionId` when a tenant is removed on
 * their side, so the row is cleaned up here too.
 */
export async function restoreSessions(): Promise<void> {
  const ids = new Set<string>();

  // Retry the initial DB read with exponential backoff. `ECHECKOUTTIMEOUT`
  // on boot is almost always a transient pool/DB availability problem —
  // Supabase pooler starting cold, the project briefly paused, or the old
  // tsx-watch process still holding sockets. Five tries over ~30s is
  // enough to ride through all three without bouncing the whole restore.
  let attempt = 0;
  const MAX_ATTEMPTS = 5;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const saved = await prisma.whatsAppSession.findMany({
        select: { sessionId: true },
      });
      for (const row of saved) ids.add(row.sessionId);

      // Also pick up any local session folders left by a previous run.
      // Without cross-table knowledge of the caller's tenant list, we trust
      // the disk match for any UUID-shaped folder name — the next boot can
      // still emit a fresh QR if WhatsApp rejects it, at which point the
      // row gets dropped (see initSession's `isRestore` path).
      try {
        const fs = await import('node:fs/promises');
        const entries = await fs.readdir(getSessionDir()).catch(() => [] as string[]);
        const UUID = /^session-([0-9a-f-]{36})$/i;
        for (const entry of entries) {
          const m = entry.match(UUID);
          if (m?.[1]) ids.add(m[1]);
        }
      } catch { /* FS scan is best-effort */ }
      break; // success — fall through to the fan-out
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        logger.error(
          { err, attempts: attempt },
          'restoreSessions giving up — worker will serve link/QR flows but not auto-restore',
        );
        return;
      }
      const delay = Math.min(15000, 1000 * 2 ** (attempt - 1));
      logger.warn(
        { err, attempt, maxAttempts: MAX_ATTEMPTS, retryInMs: delay },
        'restoreSessions DB read failed — retrying',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  logger.info({ count: ids.size }, 'restoring sessions in background');

  // Stagger Chromium launches. Without this, every saved session boots its
  // own Puppeteer instance simultaneously on cold-start. On a laptop /
  // single-host worker, the contention causes some launches to throw
  // "Execution context was destroyed" past tryInitialize's 3 retries —
  // sessions that would otherwise restore fine. 3s between launches keeps
  // disk + CPU calm; the first session is up before the next starts loading.
  const RESTORE_STAGGER_MS = 3_000;
  let i = 0;
  for (const sessionId of ids) {
    if (sessions.has(sessionId) || initializing.has(sessionId)) continue;

    const delay = i * RESTORE_STAGGER_MS;
    i++;
    initializing.add(sessionId);
    setTimeout(() => {
      // Re-check the maps after the delay — operator may have linked or
      // deleted this session via the API while we were waiting.
      if (sessions.has(sessionId)) { initializing.delete(sessionId); return; }
      initSession(sessionId, /* isRestore */ true)
        .catch((err) => {
          logger.error({ err, sessionId }, 'failed to restore session');
          sessions.delete(sessionId);
        })
        .finally(() => initializing.delete(sessionId));
    }, delay).unref();
  }
}

/**
 * Called on SIGTERM / SIGINT. For every ready session, close Chromium
 * cleanly (which flushes IndexedDB + LevelDB to disk) and THEN tar the
 * settled folder into the DB. This is the reliable persist path — unlike
 * the post-ready timer, the folder is no longer being written to, so the
 * snapshot is internally consistent and WhatsApp accepts it on the next
 * restart without a fresh QR.
 *
 * Sessions that weren't `ready` (qr_pending, connecting, disconnected) are
 * just torn down without persisting — nothing meaningful to save.
 */
export async function persistAndDestroyAll(timeoutMs = 30_000): Promise<void> {
  const entries = Array.from(sessions.entries());
  if (entries.length === 0) return;

  logger.info({ count: entries.length }, 'shutdown: closing sessions cleanly');
  const deadline = Date.now() + timeoutMs;

  // Sequential: concurrent tars would thrash disk and each one is already
  // heavy (copy + gzip of ~30-80 MB).
  for (const [sessionId, managed] of entries) {
    const log = logger.child({ sessionId });
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      log.warn('shutdown: out of time, skipping');
      continue;
    }

    try {
      if (managed.status === 'ready') {
        // Close the browser — whatsapp-web.js awaits puppeteer's graceful
        // close, which flushes the Chromium profile to disk.
        await Promise.race([
          managed.client.destroy(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('destroy timeout')), Math.min(remaining, 15_000))),
        ]).catch((err) => log.warn({ err }, 'shutdown: destroy error'));

        await managed.auth.persistToDatabase(managed.phoneNumber ?? undefined);
        log.info('shutdown: persisted');
      } else {
        // Non-ready sessions have nothing worth keeping — just close.
        await managed.client.destroy().catch(() => {});
      }
    } catch (err) {
      log.error({ err }, 'shutdown: persist failed');
    } finally {
      sessions.delete(sessionId);
    }
  }
}

export async function getSession(sessionId: string): Promise<WorkerSession | null> {
  const managed = sessions.get(sessionId);
  if (managed) {
    // Silent-disconnect detection on the polling endpoint. checkLive() has
    // a 5s cache so back-to-back polls don't add a getState round-trip
    // each. If the underlying socket has died, this flips managed.status
    // before we serialise it for the response — so the dashboard sees
    // reality, not a stale "ready". **Detect-only**: never triggers reinit
    // (that happens only on the send path).
    if (managed.status === 'ready') {
      await checkLive(sessionId).catch(() => {});
    }
    return toWorkerSession(sessionId, managed);
  }

  // Restore in-flight — tell the caller to keep polling
  if (initializing.has(sessionId)) {
    return { sessionId: sessionId, status: 'connecting', qrDataUrl: null, phoneNumber: null, lastActivity: '', readySince: null };
  }

  const hasSaved = await prisma.whatsAppSession.findUnique({ where: { sessionId }, select: { sessionId: true } });
  if (hasSaved) {
    return { sessionId: sessionId, status: 'disconnected', qrDataUrl: null, phoneNumber: null, lastActivity: '', readySince: null };
  }
  return null;
}

/**
 * Opaque pagination cursor — base64url JSON pointing at the last sessionId
 * already returned. Cursor-based (not offset) so inserts/deletes don't shift
 * pages under the caller.
 */
interface PageCursor { lastSessionId: string }
export function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function decodeCursor(s: string): PageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString()) as Partial<PageCursor>;
    return typeof parsed.lastSessionId === 'string' ? { lastSessionId: parsed.lastSessionId } : null;
  } catch {
    return null;
  }
}

export interface ListSessionsResult {
  sessions: WorkerSession[];
  nextCursor: string | null;
}

/**
 * List sessions (paginated). Lets a caller render its dashboards without
 * storing a denormalised "linked" flag on its side. Merges in-memory
 * (live) sessions and saved-only (disconnected since restart) sessions,
 * sorted by sessionId ascending so pagination is stable.
 */
export async function listSessions(opts: { limit: number; cursor?: string } = { limit: 50 }): Promise<ListSessionsResult> {
  const live = Array.from(sessions.entries()).map(([id, m]) => toWorkerSession(id, m));
  const liveIds = new Set(live.map((s) => s.sessionId));

  const saved = await prisma.whatsAppSession.findMany({
    select: { sessionId: true, phoneNumber: true, updatedAt: true },
  });

  const offline: WorkerSession[] = saved
    .filter((row) => !liveIds.has(row.sessionId))
    .map((row) => ({
      sessionId: row.sessionId,
      status: 'disconnected' as const,
      qrDataUrl: null,
      readySince: null,
      phoneNumber: row.phoneNumber,
      lastActivity: row.updatedAt.toISOString(),
    }));

  const all = [...live, ...offline].sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  let startIdx = 0;
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      // findIndex returns first session whose sessionId > cursor.lastSessionId
      startIdx = all.findIndex((s) => s.sessionId > decoded.lastSessionId);
      if (startIdx === -1) startIdx = all.length;
    }
  }

  const page = all.slice(startIdx, startIdx + opts.limit);
  const hasMore = startIdx + opts.limit < all.length;
  const nextCursor = hasMore && page.length > 0
    ? encodeCursor({ lastSessionId: page[page.length - 1]!.sessionId })
    : null;

  return { sessions: page, nextCursor };
}

// ---------------------------------------------------------------------------
// Liveness probes + self-healing reinit
//
// The bedrock problem: a session's in-memory status can read `ready` while
// the underlying WhatsApp Web socket is silently dead (Puppeteer disconnect,
// navigation, network drop). When that happens, getNumberId() throws and the
// worker historically returned the misleading "not registered". The helpers
// below give the send path a way to detect that state and recover without
// exposing the account to a ban.
//
// **Ban-safety contract:** `client.getState()` is a local DOM read inside
// the WA Web SPA — no network traffic to WhatsApp. Safe to call freely.
// `client.initialize()` does hit WhatsApp's auth flow — frequent reinits
// look like bot behaviour and risk a ban. `reinitializeSessionDebounced()`
// enforces a hard 15-minute cooldown + an in-flight lock; nothing else
// (watchdog, getSession live-check, dashboard) can trigger reinit.
// ---------------------------------------------------------------------------

const STATE_CHECK_TIMEOUT_MS = 1500;
const STATE_CHECK_CACHE_MS = 5_000;
const REINIT_COOLDOWN_MS = 15 * 60 * 1000;
// How long a session may sit in `connecting` before the watchdog treats it as
// wedged (WA Web never fired ready/qr/disconnected). Well past the ~40s worst
// case for a healthy cold boot + staggered restore. Override via env.
const STUCK_CONNECTING_MS = Number(process.env.STUCK_CONNECTING_MS) || 3 * 60_000;

// Backoff for the watchdog's DB-reconcile re-init. Without it, a session that
// fails to init throws every 5-min sweep — repeated WA re-auth attempts that
// read as the "logging in repeatedly" pattern WhatsApp flags. After a failed
// attempt we wait this long before retrying that sessionId, and alert the
// operator once a session has failed RECONCILE_ALERT_AFTER times in a row.
const RECONCILE_COOLDOWN_MS = Number(process.env.RECONCILE_COOLDOWN_MS) || 30 * 60_000;
const RECONCILE_ALERT_AFTER = 3;
// sessionId → { lastAttempt ms, consecutive failures }. Cleared on success.
const reconcileAttempts = new Map<string, { lastAttempt: number; failures: number }>();

export async function checkLive(sessionId: string, opts: { force?: boolean } = {}): Promise<'connected' | 'disconnected' | 'unknown'> {
  const managed = sessions.get(sessionId);
  if (!managed) return 'unknown';

  // Skip the round-trip if we just checked. Doesn't help correctness — it
  // helps latency, since the send path calls this before every send.
  const fresh = managed.lastStateCheck && Date.now() - managed.lastStateCheck < STATE_CHECK_CACHE_MS;
  if (fresh && !opts.force) {
    return managed.status === 'ready' ? 'connected' : 'disconnected';
  }

  let state: string | null = null;
  try {
    state = await Promise.race([
      managed.client.getState() as Promise<string>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), STATE_CHECK_TIMEOUT_MS)),
    ]);
  } catch {
    state = null;
  }
  managed.lastStateCheck = Date.now();

  if (state === 'CONNECTED') return 'connected';

  // Anything else (TIMEOUT, UNPAIRED, CONFLICT, UNLAUNCHED, OPENING,
  // PAIRING, null on Puppeteer-detached page) is non-live. Flip status if
  // we're transitioning out of `ready` so consumers see reality.
  if (managed.status === 'ready') {
    const log = logger.child({ sessionId });
    log.warn({ state }, 'session liveness check failed — marking disconnected');
    managed.status = 'disconnected';
    managed.qrDataUrl = null;
    managed.readySince = null;
    eventBus.publish('session.disconnected', {
      sessionId: sessionId,
      reason: 'liveness_check_failed:' + String(state ?? 'TIMEOUT'),
      status: 'disconnected',
      phoneNumber: managed.phoneNumber,
      qrDataUrl: null,
      lastActivity: managed.lastActivity,
    });
  }
  return 'disconnected';
}

/**
 * Watchdog sweep — runs every 5 min from src/lib/session-watchdog.ts.
 *
 * Four passes, all ban-safety-capped (see invariant #4):
 *   1. `ready` sessions: forced checkLive() to catch silent socket deaths.
 *      checkLive flips status → disconnected on failure (the handler keeps
 *      the entry in the map, see client.on('disconnected') above).
 *   2. `disconnected` sessions: reinitializeSessionDebounced (15-min cooldown,
 *      so at most one reinit per session per window).
 *   3. sessions wedged in `connecting` past STUCK_CONNECTING_MS (WA Web never
 *      fired a terminal event): alert the operator + cooldown-guarded reinit.
 *   4. DB reconcile: re-init any saved session missing from memory (boot
 *      restore failed / init threw), with its own backoff (RECONCILE_COOLDOWN_MS)
 *      and an alert after RECONCILE_ALERT_AFTER consecutive failures.
 *
 * Net effect: a network blip or a restart self-heals within ~5 min with no
 * operator action; only a rejected auth blob (needs a fresh QR) or repeated
 * failures escalate to an alert.
 */
export async function runWatchdogSweep(): Promise<void> {
  const readyIds: string[] = [];
  const disconnectedIds: string[] = [];
  const stuckConnecting: { id: string; ms: number }[] = [];
  const now = Date.now();
  for (const [id, m] of sessions.entries()) {
    if (m.status === 'ready') readyIds.push(id);
    else if (m.status === 'disconnected') disconnectedIds.push(id);
    else if (
      m.status === 'connecting' &&
      m.connectingSince &&
      now - m.connectingSince >= STUCK_CONNECTING_MS
    ) {
      stuckConnecting.push({ id, ms: now - m.connectingSince });
    }
  }
  for (const id of readyIds) {
    await checkLive(id, { force: true }).catch(() => {});
  }
  for (const id of disconnectedIds) {
    // Fire-and-forget — reinit is async and the watchdog shouldn't block
    // waiting for Chromium to spin up. In-flight lock prevents concurrent
    // reinits for the same session if a send arrives while we're working.
    reinitializeSessionDebounced(id);
  }
  // Sessions wedged in `connecting` — WA Web never fired a terminal event
  // (page load / handshake stalled). Invisible to the two passes above, so
  // without this they'd sit forever until a send happened to hit them. Alert
  // the operator AND nudge a cooldown-guarded reinit so it can self-heal
  // (tears down the wedged Chromium and re-inits from the saved blob).
  for (const { id, ms } of stuckConnecting) {
    logger.child({ sessionId: id }).warn({ stuckForMs: ms }, 'session wedged in connecting — alerting + reinit');
    alertSessionProblem(id, 'stuck_connecting', `Stuck connecting for ${Math.round(ms / 60_000)} min — WhatsApp Web never finished loading`);
    reinitializeSessionDebounced(id);
  }

  // Reconcile against the DB so every saved session comes back after a
  // restart with NO manual intervention. The boot-time restoreSessions()
  // handles the normal case, but it gives up if the DB is unreachable for
  // ~30s at boot, and an init that throws drops its entry from the map
  // entirely — both leave a saved session with no live client and nothing
  // (the passes above only see in-memory sessions) to retry it. Here we
  // re-init any saved session that isn't live or already starting.
  //
  // Safe against re-auth loops: a session whose blob WhatsApp rejected has
  // its DB row deleted on the restore-rejected path (and alerts), so it
  // won't reappear here — only sessions with a still-valid blob are retried.
  try {
    const saved = await prisma.whatsAppSession.findMany({ select: { sessionId: true } });
    const now2 = Date.now();
    const missing = saved
      .map((r) => r.sessionId)
      .filter((id) => !sessions.has(id) && !initializing.has(id))
      // Back off sessions that recently failed to re-init — retrying every
      // 5-min sweep would hammer WhatsApp's re-auth path (ban risk). Once a
      // sessionId has gone RECONCILE_COOLDOWN_MS since its last attempt it's
      // eligible again.
      .filter((id) => {
        const rec = reconcileAttempts.get(id);
        return !rec || now2 - rec.lastAttempt >= RECONCILE_COOLDOWN_MS;
      });
    let i = 0;
    for (const id of missing) {
      logger.child({ sessionId: id }).warn('watchdog: saved session missing from memory — re-initialising');
      initializing.add(id);
      const prevFailures = reconcileAttempts.get(id)?.failures ?? 0;
      reconcileAttempts.set(id, { lastAttempt: Date.now(), failures: prevFailures });
      // Stagger Chromium launches (same contention reason as restoreSessions).
      const delay = i * 3_000;
      i++;
      setTimeout(() => {
        if (sessions.has(id)) { initializing.delete(id); return; }
        initSession(id, /* isRestore */ true)
          .then(() => {
            // Init kicked off cleanly — reset the failure counter. (If it then
            // wedges in `connecting`, the stuck-connecting pass handles it.)
            reconcileAttempts.delete(id);
          })
          .catch((err) => {
            const failures = (reconcileAttempts.get(id)?.failures ?? 0) + 1;
            reconcileAttempts.set(id, { lastAttempt: Date.now(), failures });
            logger.error({ err, sessionId: id, failures }, `watchdog: re-init failed — backing off ${Math.round(RECONCILE_COOLDOWN_MS / 60_000)}min`);
            if (failures >= RECONCILE_ALERT_AFTER) {
              alertSessionProblem(id, 'connect_timeout', `Auto-recovery failed ${failures}× in a row — manual reset likely needed`);
            }
            sessions.delete(id);
          })
          .finally(() => initializing.delete(id));
      }, delay).unref();
    }
  } catch (err) {
    // DB still unreachable — next sweep retries. Don't let it abort the rest
    // of the watchdog.
    logger.warn({ err }, 'watchdog: DB reconcile read failed — will retry next sweep');
  }
}

/**
 * Reinitialise a session whose socket has died. Ban-safety guarded:
 *   - In-flight lock prevents concurrent destroy/init.
 *   - 15-minute cooldown between attempts caps the WhatsApp re-auth burst
 *     rate. Without this, a barrage of sends to a dead session would each
 *     trigger an init, which WA's bot detector will flag. `force: true`
 *     (explicit operator action) bypasses the cooldown, not the in-flight lock.
 *
 * Returns immediately if either guard would skip the attempt. The caller
 * still gets a 503 SESSION_UNHEALTHY from the surrounding send path; we're
 * accepting some delay before the session recovers in exchange for not
 * burning the linked phone.
 */
export function reinitializeSessionDebounced(sessionId: string, opts: { force?: boolean } = {}): void {
  const managed = sessions.get(sessionId);
  const log = logger.child({ sessionId });

  if (managed?.reinitInFlight) {
    log.debug('reinit already in flight — skipping');
    return;
  }
  // The cooldown protects against AUTO retriggers from the send path that
  // would re-link a dead session over and over. Operator-initiated reinits
  // (force=true, e.g. dashboard Reconnect button) bypass it — a human
  // clicking once isn't going to trip WhatsApp's bot detector. The
  // in-flight lock above still prevents concurrent destroy/init.
  if (!opts.force && managed?.lastReinitAt && Date.now() - managed.lastReinitAt < REINIT_COOLDOWN_MS) {
    const waitMin = Math.ceil((REINIT_COOLDOWN_MS - (Date.now() - managed.lastReinitAt)) / 60_000);
    log.debug({ waitMin }, 'reinit on cooldown — skipping');
    return;
  }
  if (opts.force) {
    log.info('reinit: forced by caller (operator action) — bypassing cooldown');
  }

  if (managed) {
    managed.reinitInFlight = true;
    managed.lastReinitAt = Date.now();
  }

  (async () => {
    log.info('reinit: tearing down dead session');
    try {
      if (managed) {
        await managed.client.destroy().catch(() => { /* dead anyway */ });
      }
      sessions.delete(sessionId);
      // Reuse initSession's restore path so the saved blob is picked up and
      // the existing init-failed-on-restore self-heal applies.
      await initSession(sessionId, /* isRestore */ true);
      log.info('reinit: kicked off fresh initSession');
    } catch (err) {
      log.error({ err }, 'reinit failed');
    } finally {
      const m = sessions.get(sessionId);
      if (m) m.reinitInFlight = false;
    }
  })();
}

export async function destroySession(sessionId: string): Promise<void> {
  const managed = sessions.get(sessionId);
  const log = logger.child({ sessionId });
  if (managed) {
    // Cap each teardown step so DELETE always returns promptly — a session
    // wedged in `connecting`/`qr_pending` has a Chromium page that never
    // finished loading, and client.logout()/destroy() can hang on it
    // indefinitely (logout especially: it drives a WA-Web UI flow that
    // requires a live page). A leaked browser process is the lesser evil
    // than a hung request; the next pm2 restart reaps it.
    const TEARDOWN_TIMEOUT_MS = 10_000;
    const withTimeout = (p: Promise<unknown>, label: string) =>
      Promise.race([
        Promise.resolve(p).catch(() => { /* swallow — best-effort */ }),
        new Promise<void>((resolve) => setTimeout(() => {
          log.warn({ label }, 'session teardown step timed out — forcing drop');
          resolve();
        }, TEARDOWN_TIMEOUT_MS)),
      ]);
    // Only attempt a clean WA-side logout when the session is actually live;
    // on a non-ready session there's nothing meaningful to log out of and the
    // call is the most likely to hang.
    if (managed.status === 'ready') await withTimeout(managed.client.logout(), 'logout');
    await withTimeout(managed.client.destroy(), 'destroy');
    sessions.delete(sessionId);
  }
  try { await prisma.whatsAppSession.delete({ where: { sessionId } }); } catch { /* may not exist */ }
  // Drop the cached linkedAt + token bucket so a re-link restarts the
  // warmup curve from day 1, and clear any watchdog reconcile backoff so a
  // re-linked session with the same id isn't penalised by stale failures.
  forgetAccount(sessionId);
  reconcileAttempts.delete(sessionId);
  eventBus.publish('session.deleted', { sessionId: sessionId });
}

// How long a send will wait for a not-ready session to come up before
// giving up and returning a retry. Covers Chromium cold boot (~20s) plus a
// little slack. Override via env for constrained hosts.
const SEND_RESTORE_WAIT_MS = Number(process.env.SEND_RESTORE_WAIT_MS) || 30_000;

/**
 * Ensure a session is live before a send. On a cold or just-restarted worker
 * the target session may not be in the in-memory map yet (restoreSessions()
 * is still working through its 3s-staggered launches) or may be mid-connect.
 * Rather than bounce the caller, bring this session up NOW — jumping the
 * restore queue — and wait (bounded) for it to reach `ready`.
 *
 * Returns the ready ManagedSession, or null if it couldn't be made ready
 * within `timeoutMs` (genuinely unlinked, blob rejected → qr_pending, or
 * still booting). The caller distinguishes those cases for its response.
 *
 * Reinit policy is preserved (WA ratelimits re-link attempts — invariant #4):
 * a `disconnected` session is nudged via the cooldown-guarded debounced
 * reinit, never a forced one; a never-loaded session uses the normal
 * restore-path initSession.
 */
async function ensureSessionReady(
  sessionId: string,
  timeoutMs = SEND_RESTORE_WAIT_MS,
): Promise<ManagedSession | null> {
  const log = logger.child({ sessionId });
  let managed = sessions.get(sessionId);
  if (managed?.status === 'ready') return managed;

  // Wait event-driven, not by polling: the lifecycle already publishes
  // `session.ready` (and `session.qr` / `session.auth_failure` for the
  // failure cases) on the bus. Subscribe BEFORE we trigger any bring-up or
  // re-read the map, so a fast transition can't fire in the gap and be missed
  // (check-then-wait race). The timer is a backstop for the case where no
  // terminal event ever arrives (e.g. Chromium wedged mid-launch).
  let onEvent!: (e: WorkerEvent) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<void>((resolve) => {
    onEvent = (e) => {
      if (e.data?.sessionId !== sessionId) return;
      if (
        e.type === 'session.ready' ||
        e.type === 'session.qr' ||
        e.type === 'session.auth_failure'
      ) {
        resolve();
      }
    };
    eventBus.on('event', onEvent);
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });

  try {
    if (!managed) {
      // Not in the map. If no restore is already queued/running AND there's
      // no saved blob, there's nothing to bring up — bail so the caller
      // returns "link WhatsApp first".
      if (!initializing.has(sessionId)) {
        const hasSaved = await prisma.whatsAppSession
          .findUnique({ where: { sessionId }, select: { sessionId: true } })
          .catch(() => null);
        if (!hasSaved) return null;
      }
      // Start the restore now — jumps the restoreSessions() stagger for THIS
      // session. initSession is idempotent: if the staggered timer is already
      // mid-flight it returns the existing snapshot, and the queued timer
      // no-ops once the map is populated.
      initSession(sessionId, /* isRestore */ true).catch((err) =>
        log.error({ err }, 'ensureSessionReady: restore init failed'),
      );
    } else if (managed.status === 'disconnected') {
      reinitializeSessionDebounced(sessionId); // cooldown-guarded, never forced
    } else if (managed.status === 'qr_pending') {
      return null; // blob rejected — needs a fresh QR scan; nothing to wait for
    }
    // `connecting` falls straight through to the wait below.

    // Re-read after subscribing — covers a flip to `ready` between our first
    // read and the listener being attached.
    managed = sessions.get(sessionId);
    if (managed?.status === 'ready') return managed;

    await settled; // wakes on this session's next ready/qr/auth_failure, or the timeout
    managed = sessions.get(sessionId);
    if (managed?.status !== 'ready') {
      log.warn({ timeoutMs, status: managed?.status }, 'ensureSessionReady: not ready within window');
      // qr_pending / auth_failure already alert from their own handlers; this
      // covers the "stuck connecting / never came up" case so the operator
      // still gets pinged when a send can't connect.
      if (managed?.status !== 'qr_pending') {
        alertSessionProblem(sessionId, 'connect_timeout', `Session did not reach 'ready' within ${Math.round(timeoutMs / 1000)}s of a send attempt`);
      }
    }
    return managed?.status === 'ready' ? managed : null;
  } finally {
    eventBus.off('event', onEvent);
    if (timer) clearTimeout(timer);
  }
}

export async function sendMessage(
  sessionId: string,
  to: string,
  body: string,
  opts: { override?: boolean } = {},
): Promise<SendMessageResult> {
  let managed = sessions.get(sessionId);
  const log = logger.child({ sessionId });
  // Override only skips ANTI-BAN gates (per-account spacing, recipient
  // cooldown, token buckets, jitter). Liveness, auth, and idempotency still apply.
  const override = opts.override === true;
  if (override) {
    log.warn({ to }, 'OVERRIDE — anti-ban gates bypassed for this send (high ban risk)');
  }

  if (!managed || managed.status !== 'ready') {
    // Don't bounce the caller on a cold/just-restarted worker. On a
    // power-loss / network-drop restart, restoreSessions() is still working
    // through its 3s-staggered launches, so the session may not be in the map
    // yet (or may be mid-connect). Actively bring THIS session up — jumping
    // the restore queue — and wait for it to reach `ready` before sending.
    managed = (await ensureSessionReady(sessionId)) ?? undefined;

    if (!managed) {
      // Couldn't make it ready within the window. Distinguish a still-restoring
      // session (tell the caller to retry via SESSION_UNHEALTHY → 503) from a
      // genuinely unlinked one (needs a fresh QR scan).
      const current = sessions.get(sessionId);
      const status = current?.status;
      const restoring =
        status === 'connecting' ||
        status === 'disconnected' ||
        initializing.has(sessionId) ||
        (!current &&
          !!(await prisma.whatsAppSession
            .findUnique({ where: { sessionId }, select: { sessionId: true } })
            .catch(() => null)));

      if (restoring) {
        const state = status ?? (initializing.has(sessionId) ? 'restoring' : 'disconnected');
        log.warn({ to, state }, 'session still restoring after wait — returning SESSION_UNHEALTHY (retry)');
        return {
          success: false,
          messageId: null,
          recipientPhone: to,
          error: 'Session is restoring — retry shortly.',
          sessionUnhealthy: { state, retryAfter: 10 },
          timestamp: new Date().toISOString(),
        };
      }

      // qr_pending or no saved blob — genuinely needs a fresh link / QR scan.
      return {
        success: false,
        messageId: null,
        recipientPhone: to,
        error: current ? `Session not ready (${current.status})` : 'No active session — link WhatsApp first.',
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Liveness check — the in-memory `ready` status can lie when the WA Web
  // socket has died silently. checkLive() does a cached getState() and
  // mutates managed.status if the socket is gone. On non-connected we kick
  // off a debounced reinit (hard-cooldown protects the linked phone from
  // re-link burst bans) and tell the caller to retry. Placed before the
  // rate-limit checks so a dead session doesn't consume tokens or trip
  // recipient cooldowns.
  const live = await checkLive(sessionId);
  if (live !== 'connected') {
    reinitializeSessionDebounced(sessionId);
    log.warn({ to, state: live }, 'session unhealthy — returning SESSION_UNHEALTHY');
    return {
      success: false,
      messageId: null,
      recipientPhone: to,
      error: 'Session socket is not connected — reinit is in progress; retry shortly',
      sessionUnhealthy: { state: live, retryAfter: 30 },
      timestamp: new Date().toISOString(),
    };
  }

  // Messaging-layer rate limits — recipient cooldown, then per-account
  // (warmup-aware) + global token buckets. Bulk batches loop through this
  // same path so coverage is automatic across single + bulk sends.
  // Override (operator opt-in) skips every gate below.
  if (!override) {
    // Min inter-send spacing — randomised gap between consecutive sends on
    // this account (anti-burst). The bulk loop waits this out before calling
    // us (accountSpacingWaitMs), so this gate only ever trips for single
    // sends arriving too fast; they get a retryAfter to pace by.
    const spacing = checkAccountSpacing(sessionId);
    if (!spacing.ok) {
      log.warn({ to, code: spacing.code, retryAfter: spacing.retryAfter }, 'account spacing — skipping send');
      return {
        success: false,
        messageId: null,
        recipientPhone: to,
        error: spacing.message,
        rateLimit: { code: spacing.code, retryAfter: spacing.retryAfter },
        timestamp: new Date().toISOString(),
      };
    }
    const cooldown = checkRecipientCooldown(to);
    if (!cooldown.ok) {
      log.warn({ to, retryAfter: cooldown.retryAfter }, 'recipient cooldown — skipping send');
      return {
        success: false,
        messageId: null,
        recipientPhone: to,
        error: cooldown.message,
        rateLimit: { code: cooldown.code, retryAfter: cooldown.retryAfter },
        timestamp: new Date().toISOString(),
      };
    }
    const tokens = await consumeRateTokens(sessionId);
    if (!tokens.ok) {
      log.warn({ to, code: tokens.code, retryAfter: tokens.retryAfter }, 'messaging-layer rate limit — skipping send');
      return {
        success: false,
        messageId: null,
        recipientPhone: to,
        error: tokens.message,
        rateLimit: { code: tokens.code, retryAfter: tokens.retryAfter },
        timestamp: new Date().toISOString(),
      };
    }
  }

  const chatId = normalizeToWhatsAppId(to);
  let stage: 'getNumberId' | 'sendMessage' = 'getNumberId';
  try {
    // Verify the number is actually registered on WhatsApp before sending.
    // Without this, whatsapp-web.js throws a cryptic one-char error ("t")
    // from the injected page context when the chat doesn't exist.
    let numberId: { _serialized: string } | null = null;
    let lookupThrew = false;
    try {
      numberId = await managed.client.getNumberId(chatId);
    } catch (err) {
      // Historically we collapsed this into a generic "not registered" reply,
      // which masked the dead-socket symptom in prod. Now: log it, mark
      // lookupThrew so we can disambiguate below with a forced liveness probe.
      log.error({ err, chatId }, 'getNumberId threw');
      lookupThrew = true;
      numberId = null;
    }

    if (!numberId) {
      // If the lookup *threw* (vs cleanly returned null), the most likely
      // cause is a dead WhatsApp Web socket — re-probe with force=true to
      // bypass the 5s cache and learn the real state. Only return
      // SESSION_UNHEALTHY when the probe confirms a dead socket; if the
      // socket is still alive the throw was a genuine lookup miss and we
      // preserve the "not registered" friendly message.
      if (lookupThrew) {
        const probeLive = await checkLive(sessionId, { force: true });
        if (probeLive !== 'connected') {
          reinitializeSessionDebounced(sessionId);
          log.warn({ to, chatId, state: probeLive }, 'getNumberId failure was caused by dead socket — returning SESSION_UNHEALTHY');
          return {
            success: false,
            messageId: null,
            recipientPhone: to,
            error: 'Session socket dropped during number lookup — reinit in progress; retry shortly',
            sessionUnhealthy: { state: probeLive, retryAfter: 30 },
            timestamp: new Date().toISOString(),
          };
        }
      }
      log.warn({ to, chatId }, 'send target not a WhatsApp user');
      return {
        success: false,
        messageId: null,
        recipientPhone: to,
        error: `Phone ${to} is not registered on WhatsApp`,
        timestamp: new Date().toISOString(),
      };
    }

    stage = 'sendMessage';
    // Typing indicator + 1–2 s pause makes the worker behave more like a
    // human keyboard, feeding WhatsApp's engagement score. Best-effort —
    // failures here are non-fatal; the actual sendMessage still runs.
    try {
      const chat = await managed.client.getChatById(numberId._serialized);
      await chat.sendStateTyping();
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await chat.clearState();
    } catch (e) {
      log.debug({ err: e }, 'typing indicator failed (non-fatal)');
    }

    const msg = await managed.client.sendMessage(numberId._serialized, varyBody(body));
    const timestamp = new Date().toISOString();
    managed.lastActivity = timestamp;
    recordRecipientSend(to);
    // Arm the next-allowed-send timestamp for this account (warmup-aware,
    // randomised). Recorded even on override sends so subsequent gated sends
    // still pace off the most recent activity.
    await recordAccountSend(sessionId);
    return { success: true, messageId: msg.id?.id ?? null, recipientPhone: to, timestamp };
  } catch (err) {
    log.error({ err, stage, to, chatId }, 'sendMessage failed');
    const rawMessage = err instanceof Error ? err.message : String(err);
    const friendly = rawMessage && rawMessage.length > 2
      ? rawMessage
      : `Send failed (raw="${rawMessage}") — phone may not be on WhatsApp or session is stale`;
    return {
      success: false,
      messageId: null,
      recipientPhone: to,
      error: friendly,
      timestamp: new Date().toISOString(),
    };
  }
}

function toWorkerSession(sessionId: string, m: ManagedSession): WorkerSession {
  return { sessionId: sessionId, status: m.status, qrDataUrl: m.qrDataUrl, phoneNumber: m.phoneNumber, lastActivity: m.lastActivity, readySince: m.readySince };
}

/**
 * Rewrite a user-entered phone number to the E.164 digits WhatsApp uses for
 * chat IDs (country code + subscriber, no '+', suffixed with @c.us).
 *
 * Covered countries:
 *   SO (+252), KE (+254), ET (+251), UK (+44), DE (+49), NL (+31),
 *   SE (+46), NO (+47), DK (+45), FI (+358), IS (+354), US / CA (+1).
 *
 * Ladder:
 *   1. '+' prefix  — trust the user, strip '+' and pass through.
 *   2. Internationalized digits with country code prefix at the expected
 *      length — pass through.
 *   3. Leading-0 local formats, disambiguated by prefix + length:
 *        07XXXXXXXXX (11)          → UK mobile     → 44 + last 10
 *        07XXXXXXXX  (10)          → Kenya mobile  → 254 + last 9
 *        01XXXXXXXX  (10)          → Kenya mobile  → 254 + last 9
 *        01XXXXXXXXX(X) (11-12)    → DE mobile     → 49 + last 10-11
 *        09XXXXXXXX  (10)          → ET mobile     → 251 + last 9
 *        04/05XXXXXXXX(X) (10-11)  → FI mobile     → 358 + last 9-10
 *        063/065XXXXXXX (10)       → Somaliland    → 252 + last 9
 *        06XXXXXXXX (10, !063/065) → NL mobile     → 31 + last 9
 *   4. Bare 10-digit starting 2-9 → NANP (US/CA).
 *   5. Bare 9-digit starting 6    → Somali mobile w/o leading 0.
 *
 * Known unresolvable ambiguities — users must enter these with the '+'
 * prefix (or explicit country code) to get routed correctly:
 *   - Sweden 07X 10-digit local collides with Kenya 07X (Kenya wins).
 *   - Norway & Denmark 8-digit no-0 locals collide with each other.
 *   - Iceland 7-digit no-0 is too short to classify safely.
 *   - Somali 061 / 068 etc. collide with NL 06X (063/065 wins as SO).
 */
function normalizeToWhatsAppId(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (hasPlus) return `${digits}@c.us`;

  // --- Internationalized (country code + subscriber, no '+') ------------
  // 3-digit country codes first so 2-digit checks don't steal them.
  if (digits.startsWith('251') && digits.length === 12) return `${digits}@c.us`;   // Ethiopia
  if (digits.startsWith('252') && digits.length === 12) return `${digits}@c.us`;   // Somalia
  if (digits.startsWith('254') && digits.length === 12) return `${digits}@c.us`;   // Kenya
  if (digits.startsWith('354') && digits.length === 10) return `${digits}@c.us`;   // Iceland
  if (digits.startsWith('358') && (digits.length === 12 || digits.length === 13)) {
    return `${digits}@c.us`;                                                       // Finland
  }
  // 2-digit country codes.
  if (digits.startsWith('31') && digits.length === 11) return `${digits}@c.us`;    // Netherlands
  if (digits.startsWith('44') && digits.length === 12) return `${digits}@c.us`;    // UK
  if (digits.startsWith('45') && digits.length === 10) return `${digits}@c.us`;    // Denmark
  if (digits.startsWith('46') && (digits.length === 11 || digits.length === 12)) {
    return `${digits}@c.us`;                                                       // Sweden
  }
  if (digits.startsWith('47') && digits.length === 10) return `${digits}@c.us`;    // Norway
  if (digits.startsWith('49') && (digits.length === 12 || digits.length === 13)) {
    return `${digits}@c.us`;                                                       // Germany
  }
  // 1-digit country code — US / Canada (NANP).
  if (digits.startsWith('1') && digits.length === 11) return `${digits}@c.us`;

  // --- Local formats with leading 0 -------------------------------------
  // UK mobile: 07 + 9 digits (11 total).
  if (digits.startsWith('07') && digits.length === 11) {
    return `44${digits.slice(1)}@c.us`;
  }
  // Kenya mobile: 07 or 01 + 8 digits (10 total).
  if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) {
    return `254${digits.slice(1)}@c.us`;
  }
  // Germany mobile: 01 + 9-10 digits (11-12 total).
  if (digits.startsWith('01') && (digits.length === 11 || digits.length === 12)) {
    return `49${digits.slice(1)}@c.us`;
  }
  // Ethiopia mobile: 09 + 8 digits (10 total).
  if (digits.startsWith('09') && digits.length === 10) {
    return `251${digits.slice(1)}@c.us`;
  }
  // Finland mobile: 04/05 + 8-9 digits (10-11 total).
  if ((digits.startsWith('04') || digits.startsWith('05')) &&
      (digits.length === 10 || digits.length === 11)) {
    return `358${digits.slice(1)}@c.us`;
  }
  // 06X: Somaliland first (specific sub-prefixes), then NL for everything else.
  if ((digits.startsWith('063') || digits.startsWith('065')) && digits.length === 10) {
    return `252${digits.slice(1)}@c.us`;
  }
  if (digits.startsWith('06') && digits.length === 10) {
    return `31${digits.slice(1)}@c.us`;
  }

  // --- Bare formats (no leading 0, no country code prefix) --------------
  if (digits.length === 10 && /^[2-9]/.test(digits)) {
    return `1${digits}@c.us`;                                                      // NANP
  }
  if (digits.length === 9 && digits.startsWith('6')) {
    return `252${digits}@c.us`;                                                    // SO mobile no-0
  }

  return `${digits}@c.us`;
}
