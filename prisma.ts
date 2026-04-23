import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// tsx doesn't auto-load .env like Next.js does — load it before any env checks
try { process.loadEnvFile('.env'); } catch { /* file may not exist in prod */ }
try { process.loadEnvFile('.env.local'); } catch { /* optional override */ }

if (!process.env.DATABASE_URL) {
  throw new Error('[worker] DATABASE_URL is not set');
}

// tsx watch restarts the process on file change, but during a brief
// overlap the old process's sockets are still open while the new one is
// connecting. Memoize on globalThis — same trick as src/lib/prisma.ts —
// so at least within a single process lifetime we never stack clients.
const globalForPrisma = globalThis as unknown as { workerPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.workerPrisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (!globalForPrisma.workerPrisma) globalForPrisma.workerPrisma = prisma;
