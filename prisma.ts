import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// tsx doesn't auto-load .env like Next.js does — load it before any env checks
try { process.loadEnvFile('.env'); } catch { /* file may not exist in prod */ }
try { process.loadEnvFile('.env.local'); } catch { /* optional override */ }

if (!process.env.DATABASE_URL) {
  throw new Error('[worker] DATABASE_URL is not set');
}

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
