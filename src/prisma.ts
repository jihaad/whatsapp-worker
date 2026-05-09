import { PrismaClient } from '../prisma/generated/client/client';
import { PrismaPg } from '@prisma/adapter-pg';

// tsx doesn't auto-load .env like Next.js does — load it before any env checks
try { process.loadEnvFile('.env'); } catch { /* file may not exist in prod */ }
try { process.loadEnvFile('.env.local'); } catch { /* optional override */ }

// The worker is a long-lived process with periodic loops + on-demand send
// HTTP handlers. Connect via the **session pooler** (DIRECT_URL, port 5432),
// not the transaction pooler (DATABASE_URL, port 6543).
//
// Why: Supabase's transaction pooler is sized for serverless functions
// (free tier ~15 slots). With FD's Vercel app + the worker both pulling
// connection_limit=10 from a 15-slot pool, we'd hit ECHECKOUTTIMEOUT under
// any concurrent load. The session pooler has ~200 slots and gives each
// long-lived client a stable connection — exactly what the worker wants.
//
// **Pure-API note:** the worker uses the same Supabase project as FD
// (same DIRECT_URL credentials). Isolation is enforced by the worker's
// Prisma schema scope — it only declares `WhatsAppSession`, not any FD
// domain models, so the worker can't accidentally query FD tables.
//
// Optional: a dedicated `WORKER_DATABASE_URL` env var lets you override
// (e.g. point at a separate Postgres later). Falls back to DIRECT_URL.
const workerConnString = process.env.WORKER_DATABASE_URL ?? process.env.DIRECT_URL;
if (!workerConnString) {
  throw new Error('[worker] DIRECT_URL (session pooler) is not set — required for the worker. Set DIRECT_URL or WORKER_DATABASE_URL in .env.');
}

// tsx watch restarts the process on file change, but during a brief
// overlap the old process's sockets are still open while the new one is
// connecting. Memoize on globalThis so at least within a single process
// lifetime we never stack clients.
const globalForPrisma = globalThis as unknown as { workerPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.workerPrisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: workerConnString }),
  });

if (!globalForPrisma.workerPrisma) globalForPrisma.workerPrisma = prisma;
