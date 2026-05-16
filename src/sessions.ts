import { Client } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import { DatabaseAuth } from './database-auth';
import { prisma } from './prisma';
import { logger } from './logger';
import { eventBus } from './events';
import { checkRecipientCooldown, consumeRateTokens, recordRecipientSend, forgetAccount } from './lib/messaging-limits';
import { varyBody } from './lib/body-variation';

/**
 * Long-lived session manager for the WhatsApp worker process.
 *
 * The worker is the **transport layer** — it knows about WhatsApp Web
 * sessions keyed by an opaque UUID (`schoolId` in code for historical
 * reasons; treat it as an arbitrary tenant identifier). No knowledge of
 * the calling application's domain models. Callers track linked status
 * for their own UI by polling the worker's HTTP API.
 *
 * Session blobs persist in `whatsapp_sessions.sessionData` as tar.gz —
 * Chromium restores from the DB on worker startup without requiring a new
 * QR scan. Status is held in-memory only.
 */

export type SessionStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'ready';

export interface SchoolSession {
  sessionId: string;
  status: SessionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  lastActivity: string;
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
  rateLimit?: { code: 'RECIPIENT_COOLDOWN' | 'ACCOUNT_RATE_LIMIT' | 'WARMUP_LIMIT' | 'GLOBAL_RATE_LIMIT'; retryAfter: number };
}

interface ManagedSession {
  client: Client;
  auth: DatabaseAuth;
  status: SessionStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  lastActivity: string;
}

const sessions = new Map<string, ManagedSession>();

/**
 * schoolIds whose initSession() is currently in-flight (Chromium launching).
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
async function tryInitialize(client: Client, schoolId: string): Promise<void> {
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
        const sessionDir = join(getSessionDir(), `session-${schoolId}`);
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
export async function initSession(schoolId: string, isRestore = false): Promise<SchoolSession> {
  const existing = sessions.get(schoolId);
  if (existing) {
    return toSchoolSession(schoolId, existing);
  }

  eventBus.publish('session.init', { sessionId: schoolId, isRestore });
  const log = logger.child({ schoolId });
  const auth = new DatabaseAuth({ clientId: schoolId, dataPath: getSessionDir() });
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
  };
  sessions.set(schoolId, managed);

  // Fires once per initSession lifecycle — used to detect a failed restore
  // (QR event after we extracted a saved blob = blob is dead).
  let qrSeen = false;

  client.on('qr', async (qr: string) => {
    try {
      managed.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      managed.status = 'qr_pending';
      managed.lastActivity = new Date().toISOString();
      log.info({ elapsedMs: Date.now() - initStart }, 'qr ready');
      eventBus.publish('session.qr', { sessionId: schoolId, elapsedMs: Date.now() - initStart });

      if (isRestore && !qrSeen) {
        qrSeen = true;
        log.warn('restore rejected by WhatsApp — dropping stale blob');
        await prisma.whatsAppSession.delete({ where: { schoolId } }).catch(() => {});
      }
    } catch {
      managed.qrDataUrl = null;
    }
  });

  client.on('ready', async () => {
    managed.status = 'ready';
    managed.qrDataUrl = null;
    managed.lastActivity = new Date().toISOString();
    const info = client.info;
    if (info?.wid?.user) managed.phoneNumber = info.wid.user;
    log.info({ phoneNumber: managed.phoneNumber }, 'session ready');
    eventBus.publish('session.ready', { sessionId: schoolId, phoneNumber: managed.phoneNumber });

    // Wait for Chromium to flush IndexedDB to disk before taring the session.
    // 20s gives the initial WhatsApp history sync room to land before we
    // snapshot — a tar taken mid-LevelDB-compaction restores to a profile
    // that WhatsApp refuses on the next boot and emits a fresh QR for. This
    // is the crash-fallback path; clean shutdown re-persists from a fully
    // settled Chromium (see persistAndDestroyAll below).
    await new Promise((r) => setTimeout(r, 20000));

    await auth.persistToDatabase(managed.phoneNumber ?? undefined).catch((err) => {
      log.error({ err }, 'persist on ready failed');
    });
  });

  client.on('authenticated', () => {
    log.info('authenticated');
    eventBus.publish('session.authenticated', { sessionId: schoolId });
    managed.status = 'connecting';
    managed.lastActivity = new Date().toISOString();
  });

  client.on('loading_screen', (pct: number, msg: string) => {
    log.debug({ pct, msg }, 'loading');
  });

  client.on('disconnected', (reason) => {
    log.info({ reason }, 'session disconnected');
    eventBus.publish('session.disconnected', { sessionId: schoolId, reason: String(reason) });
    managed.status = 'disconnected';
    managed.qrDataUrl = null;
    managed.lastActivity = new Date().toISOString();
    sessions.delete(schoolId);
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

  client.on('auth_failure', (msg) => {
    log.error({ msg }, 'auth failure');
    eventBus.publish('session.auth_failure', { sessionId: schoolId, reason: String(msg) });
    managed.status = 'disconnected';
    managed.qrDataUrl = null;
    sessions.delete(schoolId);
  });

  // Kick Chromium off in the background. Awaiting client.initialize() here
  // adds ~10s of dead spinner time on the client before the QR even has a
  // chance to appear — the UI already polls getSession() every 2s, so we
  // just return the `connecting` session immediately and let the poll pick
  // up the QR the moment it's emitted.
  tryInitialize(client, schoolId).catch((err) => {
    log.error({ err }, 'init failed');
    sessions.delete(schoolId);
    client.destroy().catch(() => {});
  });

  return toSchoolSession(schoolId, managed);
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
        select: { schoolId: true },
      });
      for (const row of saved) ids.add(row.schoolId);

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

  for (const schoolId of ids) {
    if (sessions.has(schoolId) || initializing.has(schoolId)) continue;

    initializing.add(schoolId);
    initSession(schoolId, /* isRestore */ true)
      .catch((err) => {
        logger.error({ err, schoolId }, 'failed to restore session');
        sessions.delete(schoolId);
      })
      .finally(() => initializing.delete(schoolId));
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
  for (const [schoolId, managed] of entries) {
    const log = logger.child({ schoolId });
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
      sessions.delete(schoolId);
    }
  }
}

export async function getSession(schoolId: string): Promise<SchoolSession | null> {
  const managed = sessions.get(schoolId);
  if (managed) {
    return toSchoolSession(schoolId, managed);
  }

  // Restore in-flight — tell the caller to keep polling
  if (initializing.has(schoolId)) {
    return { sessionId: schoolId, status: 'connecting', qrDataUrl: null, phoneNumber: null, lastActivity: '' };
  }

  const hasSaved = await prisma.whatsAppSession.findUnique({ where: { schoolId }, select: { schoolId: true } });
  if (hasSaved) {
    return { sessionId: schoolId, status: 'disconnected', qrDataUrl: null, phoneNumber: null, lastActivity: '' };
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
  sessions: SchoolSession[];
  nextCursor: string | null;
}

/**
 * List sessions (paginated). Lets a caller render its dashboards without
 * storing a denormalised "linked" flag on its side. Merges in-memory
 * (live) sessions and saved-only (disconnected since restart) sessions,
 * sorted by sessionId ascending so pagination is stable.
 */
export async function listSessions(opts: { limit: number; cursor?: string } = { limit: 50 }): Promise<ListSessionsResult> {
  const live = Array.from(sessions.entries()).map(([id, m]) => toSchoolSession(id, m));
  const liveIds = new Set(live.map((s) => s.sessionId));

  const saved = await prisma.whatsAppSession.findMany({
    select: { schoolId: true, phoneNumber: true, updatedAt: true },
  });

  const offline: SchoolSession[] = saved
    .filter((row) => !liveIds.has(row.schoolId))
    .map((row) => ({
      sessionId: row.schoolId,
      status: 'disconnected' as const,
      qrDataUrl: null,
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

export async function destroySession(schoolId: string): Promise<void> {
  const managed = sessions.get(schoolId);
  if (managed) {
    try { await managed.client.logout(); } catch { /* continue */ }
    try { await managed.client.destroy(); } catch { /* continue */ }
    sessions.delete(schoolId);
  }
  try { await prisma.whatsAppSession.delete({ where: { schoolId } }); } catch { /* may not exist */ }
  // Drop the cached linkedAt + token bucket so a re-link restarts the
  // warmup curve from day 1.
  forgetAccount(schoolId);
  eventBus.publish('session.deleted', { sessionId: schoolId });
}

export async function sendMessage(schoolId: string, to: string, body: string): Promise<SendMessageResult> {
  const managed = sessions.get(schoolId);
  const log = logger.child({ schoolId });

  if (!managed || managed.status !== 'ready') {
    return {
      success: false,
      messageId: null,
      recipientPhone: to,
      error: managed ? `Session not ready (${managed.status})` : 'No active session — link WhatsApp first.',
      timestamp: new Date().toISOString(),
    };
  }

  // Messaging-layer rate limits — recipient cooldown, then per-account
  // (warmup-aware) + global token buckets. Bulk batches loop through this
  // same path so coverage is automatic across single + bulk sends.
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
  const tokens = await consumeRateTokens(schoolId);
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

  const chatId = normalizeToWhatsAppId(to);
  let stage: 'getNumberId' | 'sendMessage' = 'getNumberId';
  try {
    // Verify the number is actually registered on WhatsApp before sending.
    // Without this, whatsapp-web.js throws a cryptic one-char error ("t")
    // from the injected page context when the chat doesn't exist.
    let numberId: { _serialized: string } | null = null;
    try {
      numberId = await managed.client.getNumberId(chatId);
    } catch (err) {
      // getNumberId errors aren't fatal — fall through to the raw sendMessage
      // attempt, which might still succeed. Log so we can see what's breaking.
      log.error({ err, chatId }, 'getNumberId threw');
      numberId = null;
    }

    if (!numberId) {
      log.warn({ to, chatId }, 'send target not a WhatsApp user (or getNumberId threw — see above)');
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

function toSchoolSession(schoolId: string, m: ManagedSession): SchoolSession {
  return { sessionId: schoolId, status: m.status, qrDataUrl: m.qrDataUrl, phoneNumber: m.phoneNumber, lastActivity: m.lastActivity };
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
