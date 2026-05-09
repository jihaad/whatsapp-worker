import { LocalAuth } from 'whatsapp-web.js';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rm, cp } from 'node:fs/promises';
import { create, extract } from 'tar';
import { prisma } from './prisma';

/**
 * Chromium cache directories that bloat a long-running session profile but
 * are NOT needed to restore the WhatsApp Web auth state — Chromium
 * regenerates them on next start. Excluding them from the persisted blob
 * keeps the upload small enough to finish within Supabase's statement
 * timeout (we've seen sessions grow to 180MB+ after a few weeks; 149MB of
 * that was these caches).
 *
 * Match against POSIX paths inside the tarball — tar normalises separators
 * regardless of host OS.
 */
const CACHE_DIR_PATTERNS = [
  '/Default/Cache/',
  '/Default/Code Cache/',
  '/Default/GPUCache/',
  '/Default/DawnWebGPUCache/',
  '/Default/DawnGraphiteCache/',
];

function isDisposableCachePath(path: string): boolean {
  return CACHE_DIR_PATTERNS.some((needle) => path.includes(needle));
}

/**
 * Copy a directory tree, retrying on ENOENT. WhatsApp Web's IndexedDB lives
 * in a LevelDB folder that compacts in the background — older `.log` files
 * get rewritten/deleted while we're trying to copy.
 */
async function copyDirWithRetry(src: string, dst: string, attempts = 4): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rmrf(dst);
      await cp(src, dst, { recursive: true, force: true, errorOnExist: false });
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT' && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

/**
 * `fs/promises.rm` maxRetries is ignored on macOS/Linux (Windows only).
 * Manually retry on ENOTEMPTY, which happens when LevelDB compaction writes
 * new files between the file-unlink and the rmdir syscalls.
 */
async function rmrf(path: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOTEMPTY' && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

/**
 * Custom auth strategy: session data lives in the database
 * (`whatsapp_sessions.sessionData`), compressed as tar.gz. Before Puppeteer
 * launches we extract the blob to the local session folder; after ready we
 * upload the folder back to the DB.
 *
 * **Pure-API note:** this class only writes to its own table. It does NOT
 * touch any FD domain table (no `school.whatsappLinked` flag updates). The
 * worker reports session state via the HTTP API; FD reads it from there.
 */
export class DatabaseAuth extends LocalAuth {
  private readonly schoolId: string;
  private readonly resolvedDataPath: string;

  constructor(opts: { clientId: string; dataPath?: string }) {
    super(opts);
    this.schoolId = opts.clientId;
    this.resolvedDataPath = resolve(opts.dataPath ?? './.wwebjs_auth/');

    const parentBeforeBrowserInitialized = this.beforeBrowserInitialized.bind(this);
    const parentAfterAuthReady = this.afterAuthReady.bind(this);
    const parentLogout = this.logout.bind(this);

    this.beforeBrowserInitialized = async () => {
      await this.restoreFromDatabase();
      await parentBeforeBrowserInitialized();
    };

    this.afterAuthReady = async () => {
      await parentAfterAuthReady();
      // Do NOT persist here. afterAuthReady fires during the auth window
      // before the IndexedDB / LevelDB has finished hydrating from disk on
      // a restore, and before the full message store has synced on a fresh
      // link. Tarring mid-hydration captures a half-compacted LevelDB tree
      // that restores cleanly to a broken session. The 'ready' handler in
      // sessions.ts does the real persist after a 5s flush window.
    };

    this.logout = async () => {
      await parentLogout();
      await this.clearFromDatabase();
    };
  }

  private async restoreFromDatabase(): Promise<void> {
    const sessionDirName = `session-${this.schoolId}`;
    const sessionDir = join(this.resolvedDataPath, sessionDirName);

    try {
      const saved = await prisma.whatsAppSession.findUnique({
        where: { schoolId: this.schoolId },
        select: { sessionData: true },
      });
      if (!saved?.sessionData) {
        console.log(`[DatabaseAuth] no saved session blob for ${this.schoolId} — fresh link flow`);
        return;
      }

      mkdirSync(this.resolvedDataPath, { recursive: true });
      await rmrf(sessionDir);

      const tmpTar = join(this.resolvedDataPath, `${this.schoolId}.restore.tar.gz`);
      await writeFile(tmpTar, Buffer.from(saved.sessionData));
      try {
        await extract({ file: tmpTar, cwd: this.resolvedDataPath });
        console.log(`[DatabaseAuth] restored ${Buffer.from(saved.sessionData).length} bytes → ${sessionDir}`);
      } finally {
        await rm(tmpTar, { force: true });
      }

      // Remove Chromium profile lock files left by the previous container.
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        await rm(join(sessionDir, lock), { force: true });
      }
    } catch (e) {
      console.error(`[DatabaseAuth] restore failed for ${this.schoolId}:`, e);
    }
  }

  async persistToDatabase(phoneNumber?: string): Promise<void> {
    const sessionDirName = `session-${this.schoolId}`;
    const sessionDir = join(this.resolvedDataPath, sessionDirName);
    if (!existsSync(sessionDir)) return;

    const snapshotRoot = join(this.resolvedDataPath, `.snapshot-${this.schoolId}`);
    const snapshotSession = join(snapshotRoot, sessionDirName);
    const tmpTar = join(this.resolvedDataPath, `${this.schoolId}.save.tar.gz`);

    try {
      await rmrf(snapshotRoot);
      mkdirSync(snapshotRoot, { recursive: true });
      await copyDirWithRetry(sessionDir, snapshotSession);

      await create(
        {
          gzip: true,
          file: tmpTar,
          cwd: snapshotRoot,
          filter: (path) => !isDisposableCachePath(path),
        },
        [sessionDirName],
      );
      const blob = await readFile(tmpTar);
      console.log(`[DatabaseAuth] persisting ${this.schoolId}: ${(blob.byteLength / 1024 / 1024).toFixed(1)}MB`);

      // Only the worker's own table is touched. FD's `school.whatsapp*`
      // columns are FD's responsibility — it polls the worker API and
      // updates them on its side.
      await prisma.whatsAppSession.upsert({
        where: { schoolId: this.schoolId },
        create: { schoolId: this.schoolId, sessionData: blob, phoneNumber: phoneNumber ?? null },
        update: { sessionData: blob, ...(phoneNumber ? { phoneNumber } : {}) },
      });
      console.log(`[DatabaseAuth] session persisted for ${this.schoolId}`);
    } finally {
      await rm(tmpTar, { force: true });
      await rmrf(snapshotRoot);
    }
  }

  async clearFromDatabase(): Promise<void> {
    try {
      await prisma.whatsAppSession.delete({ where: { schoolId: this.schoolId } });
    } catch { /* row may not exist */ }
  }
}
