-- Outbound delivery/read receipt tracking on whatsapp_message_events.
--
-- Adds an `ack` column (populated only on `message.ack` rows: -1..4, the
-- whatsapp-web.js MessageAck level) and an index on "messageId" so the
-- GET /v1/messages/:messageId/status poll (and the bulk-batch ack merge) can
-- look up a message's current delivery state without a full-table scan.
--
-- Apply with `prisma db execute --file prisma/sql/add_message_ack.sql` (NOT
-- `db push` — see add_message_events.sql for why). Idempotent; safe to re-run.
--
-- Keep in sync with the WhatsAppMessageEvent model in prisma/schema.prisma.

ALTER TABLE whatsapp_message_events
  ADD COLUMN IF NOT EXISTS ack INTEGER;

CREATE INDEX IF NOT EXISTS whatsapp_message_events_messageid_idx
  ON whatsapp_message_events ("messageId");
