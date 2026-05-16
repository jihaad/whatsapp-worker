-- Worker-owned table: whatsapp_bulk_batches
--
-- Created via `prisma db execute` rather than `prisma db push` because the
-- worker's schema.prisma intentionally omits any other applications' tables
-- that may share the same database, and `db push` would propose dropping
-- them. This file is the canonical migration; re-running is safe
-- (idempotent via IF NOT EXISTS).
--
-- Keep in sync with the WhatsAppBulkBatch model in prisma/schema.prisma.

CREATE TABLE IF NOT EXISTS whatsapp_bulk_batches (
  "batchId"     UUID PRIMARY KEY,
  "sessionId"   UUID NOT NULL,
  status        TEXT NOT NULL,
  total         INTEGER NOT NULL,
  succeeded     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  results       JSONB NOT NULL DEFAULT '[]'::jsonb,
  "startedAt"   TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS whatsapp_bulk_batches_session_idx
  ON whatsapp_bulk_batches ("sessionId");

CREATE INDEX IF NOT EXISTS whatsapp_bulk_batches_created_idx
  ON whatsapp_bulk_batches ("createdAt");
