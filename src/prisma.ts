import { PrismaClient } from '../prisma/generated/client/client';
import { PrismaPg } from '@prisma/adapter-pg';

// tsx doesn't auto-load .env like Next.js does — load it before any env checks
try { process.loadEnvFile('.env'); } catch { /* file may not exist in prod */ }
try { process.loadEnvFile('.env.local'); } catch { /* optional override */ }

// The worker is a long-lived process with periodic loops + on-demand send
// HTTP handlers. If you're on Supabase, connect via the **session pooler**
// (port 5432) rather than the transaction pooler — the latter is sized for
// short-lived serverless functions and the worker would quickly exhaust
// the connection_limit budget.
//
// **Isolation note:** the worker can safely share a database with other
// applications. The Prisma schema scope is the boundary — only worker-owned
// tables are declared (`whatsapp_sessions`, `whatsapp_bulk_batches`,
// `whatsapp_message_events`), so the generated client cannot query other
// applications' tables even if they live in the same Postgres.
const workerConnString = process.env.DIRECT_URL;
if (!workerConnString) {
  throw new Error('[worker] DIRECT_URL is not set — required for the worker. Set DIRECT_URL in .env (session pooler URL on Supabase, port 5432).');
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
