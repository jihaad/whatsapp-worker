import { Client } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import { DatabaseAuth } from './database-auth';
import { prisma } from './prisma';

/**
 * Long-lived session manager for the WhatsApp worker process.
 *
 * Unlike the embedded Next.js version, this runs in a stable process that is
 * never hot-reloaded, so there are no orphaned Chromium processes to clean up.
 * Session blobs persist in `whatsapp_sessions` — Chromium restores from the DB
 * on worker startup without requiring a new QR scan.
 */

export type SessionStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'ready';

export interface SchoolSession {
  schoolId: string;
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
  try {
    await client.initialize();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (!msg.includes('browser is already running')) throw err;

    // Crash-restart case: old Chromium is dead, lock files are stale.
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const sessionDir = join(getSessionDir(), `session-${schoolId}`);
    await rm(join(sessionDir, 'SingletonLock'), { force: true }).catch(() => {});
    await rm(join(sessionDir, 'DevToolsActivePort'), { force: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await client.initialize();
  }
}

export async function initSession(schoolId: string): Promise<SchoolSession> {
  const existing = sessions.get(schoolId);
  if (existing) {
    if (existing.status === 'ready') {
      void prisma.school.update({
        where: { id: schoolId },
        data: { whatsappLinked: true, whatsappPhone: existing.phoneNumber ?? null, whatsappLastActivity: new Date() },
      }).catch(() => {});
    }
    return toSchoolSession(schoolId, existing);
  }

  const auth = new DatabaseAuth({ clientId: schoolId, dataPath: getSessionDir() });
  const client = new Client({
    authStrategy: auth,
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
        '--no-zygote',
        '--single-process',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
      ],
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

  client.on('qr', async (qr: string) => {
    try {
      managed.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      managed.status = 'qr_pending';
      managed.lastActivity = new Date().toISOString();
      console.log(`[worker] QR ready for ${schoolId}`);
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
    console.log(`[worker] Session ready for ${schoolId} (${managed.phoneNumber ?? 'unknown'})`);

    // Wait for Chromium to flush IndexedDB to disk before taring the session.
    await new Promise((r) => setTimeout(r, 5000));

    await auth.persistToDatabase(managed.phoneNumber ?? undefined).catch((e) => {
      console.error(`[worker] persist on ready failed for ${schoolId}:`, e);
    });
    await prisma.school.update({
      where: { id: schoolId },
      data: { whatsappLinked: true, whatsappPhone: managed.phoneNumber ?? null, whatsappLastActivity: new Date() },
    }).catch((e) => console.error(`[worker] school update failed for ${schoolId}:`, e));
  });

  client.on('authenticated', () => {
    managed.status = 'connecting';
    managed.lastActivity = new Date().toISOString();
  });

  client.on('disconnected', (reason) => {
    console.log(`[worker] Session disconnected for ${schoolId}:`, reason);
    managed.status = 'disconnected';
    managed.qrDataUrl = null;
    managed.lastActivity = new Date().toISOString();
    sessions.delete(schoolId);
  });

  client.on('auth_failure', (msg) => {
    console.error(`[worker] Auth failure for ${schoolId}:`, msg);
    managed.status = 'disconnected';
    managed.qrDataUrl = null;
    sessions.delete(schoolId);
  });

  try {
    await tryInitialize(client, schoolId);
  } catch (err) {
    // Clean up so getSession() returns 'disconnected' instead of hanging on 'connecting'
    sessions.delete(schoolId);
    try { await client.destroy(); } catch { /* ignore */ }
    throw err;
  }

  return toSchoolSession(schoolId, managed);
}

/**
 * Restore all previously-linked sessions on worker startup.
 * Fires each initSession() in the background so the worker HTTP server
 * is available immediately while Chromium boots in the background.
 */
export async function restoreSessions(): Promise<void> {
  const ids = new Set<string>();

  try {
    const saved = await prisma.whatsAppSession.findMany({
      select: { schoolId: true },
    });
    for (const row of saved) ids.add(row.schoolId);

    // Also pick up any local session folders left by a previous run
    try {
      const fs = await import('node:fs/promises');
      const entries = await fs.readdir(getSessionDir()).catch(() => [] as string[]);
      const UUID = /^session-([0-9a-f-]{36})$/i;
      for (const name of entries) {
        const m = name.match(UUID);
        if (m) ids.add(m[1]);
      }
    } catch { /* FS scan is best-effort */ }
  } catch (err) {
    console.error('[worker] restoreSessions DB query failed:', err);
    return;
  }

  console.log(`[worker] Restoring ${ids.size} session(s) in background…`);

  for (const schoolId of ids) {
    if (sessions.has(schoolId) || initializing.has(schoolId)) continue;

    initializing.add(schoolId);
    initSession(schoolId)
      .catch((err) => {
        console.error(`[worker] failed to restore ${schoolId}:`, err);
        sessions.delete(schoolId);
      })
      .finally(() => initializing.delete(schoolId));
  }
}

export async function getSession(schoolId: string): Promise<SchoolSession | null> {
  const managed = sessions.get(schoolId);
  if (managed) {
    if (managed.status === 'ready') {
      void prisma.school.update({
        where: { id: schoolId },
        data: { whatsappLinked: true, whatsappPhone: managed.phoneNumber ?? null, whatsappLastActivity: new Date() },
      }).catch(() => {});
    }
    return toSchoolSession(schoolId, managed);
  }

  // Restore in-flight — tell the caller to keep polling
  if (initializing.has(schoolId)) {
    return { schoolId, status: 'connecting', qrDataUrl: null, phoneNumber: null, lastActivity: '' };
  }

  const hasSaved = await prisma.whatsAppSession.findUnique({ where: { schoolId }, select: { schoolId: true } });
  if (hasSaved) {
    return { schoolId, status: 'disconnected', qrDataUrl: null, phoneNumber: null, lastActivity: '' };
  }
  return null;
}

export async function destroySession(schoolId: string): Promise<void> {
  const managed = sessions.get(schoolId);
  if (managed) {
    try { await managed.client.logout(); } catch { /* continue */ }
    try { await managed.client.destroy(); } catch { /* continue */ }
    sessions.delete(schoolId);
  }
  try { await prisma.whatsAppSession.delete({ where: { schoolId } }); } catch { /* may not exist */ }
  await prisma.school.update({
    where: { id: schoolId },
    data: { whatsappLinked: false, whatsappPhone: null },
  }).catch(() => {});
}

export async function sendMessage(schoolId: string, to: string, body: string): Promise<SendMessageResult> {
  const managed = sessions.get(schoolId);

  if (!managed || managed.status !== 'ready') {
    return {
      success: false,
      messageId: null,
      recipientPhone: to,
      error: managed ? `Session not ready (${managed.status})` : 'No active session — link WhatsApp first.',
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const chatId = normalizeToWhatsAppId(to);
    const msg = await managed.client.sendMessage(chatId, body);
    managed.lastActivity = new Date().toISOString();
    prisma.school.update({ where: { id: schoolId }, data: { whatsappLastActivity: new Date() } }).catch(() => {});
    return { success: true, messageId: msg.id?.id ?? null, recipientPhone: to, timestamp: new Date().toISOString() };
  } catch (error) {
    return {
      success: false,
      messageId: null,
      recipientPhone: to,
      error: error instanceof Error ? error.message : 'Failed to send message',
      timestamp: new Date().toISOString(),
    };
  }
}

function toSchoolSession(schoolId: string, m: ManagedSession): SchoolSession {
  return { schoolId, status: m.status, qrDataUrl: m.qrDataUrl, phoneNumber: m.phoneNumber, lastActivity: m.lastActivity };
}

function normalizeToWhatsAppId(phone: string): string {
  const digits = phone.replace(/[\s\-\+]/g, '');
  if (digits.startsWith('252') && digits.length === 12) return `${digits}@c.us`;
  if ((digits.startsWith('063') || digits.startsWith('065')) && digits.length === 10) return `252${digits.slice(1)}@c.us`;
  return `${digits}@c.us`;
}
