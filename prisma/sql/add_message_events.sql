-- Worker-owned table: whatsapp_message_events
--
-- Append-only log of every send / send-failure / bulk milestone. Powers the
-- dashboard's "Messages" feed across worker restarts and dashboard reloads.
-- Distinct from pino logs (which are stdout/aggregator) and the in-memory
-- ring buffer in src/events.ts (which is process-lifetime only).
--
-- Created via `prisma db execute` rather than `prisma db push` because the
-- worker's schema.prisma intentionally omits any other applications' tables
-- that may share the same database, and `db push` would propose dropping
-- them. Re-running is safe (idempotent via IF NOT EXISTS).
--
-- Keep in sync with the WhatsAppMessageEvent model in prisma/schema.prisma.

CREATE TABLE IF NOT EXISTS whatsapp_message_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type        TEXT NOT NULL,
  "sessionId" UUID,
  recipient   TEXT,
  "messageId" TEXT,
  "batchId"   UUID,
  error       TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS whatsapp_message_events_ts_idx
  ON whatsapp_message_events (ts DESC);

CREATE INDEX IF NOT EXISTS whatsapp_message_events_session_idx
  ON whatsapp_message_events ("sessionId");
