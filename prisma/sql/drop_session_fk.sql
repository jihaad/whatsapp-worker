-- Drop the legacy foreign-key constraint on whatsapp_sessions.schoolId.
--
-- The worker is transport-only and treats sessionId as an opaque tenant key —
-- it must accept any UUID, regardless of whether a row exists in the
-- (FD-owned) schools table. The FK was inherited from when the worker was
-- an FD module; it doesn't appear in prisma/schema.prisma (no @relation)
-- but lives on at the DB level and blocks fresh-link flows from the
-- dashboard with `P2003 ForeignKeyConstraintViolation`.
--
-- Safe to drop: nothing in the worker writes a row that depends on the
-- referenced row's existence. Once TODO §3 ships and the worker has its own
-- Supabase project, this constraint can never re-appear.
--
-- Apply with:
--   set -a; source .env; set +a
--   npx prisma db execute --file ./prisma/sql/drop_session_fk.sql

ALTER TABLE whatsapp_sessions
  DROP CONSTRAINT IF EXISTS whatsapp_sessions_schoolId_fkey;
