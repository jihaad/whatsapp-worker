-- Rename whatsapp_sessions.schoolId → sessionId.
--
-- `schoolId` was a vestige of the worker's original use case. The HTTP
-- contract already uses `sessionId` (path params, request bodies, event
-- payloads, OpenAPI schema). This brings the storage column in line so
-- internal code can stop translating between the two.
--
-- The primary-key constraint name (`whatsapp_sessions_pkey`) is column-
-- agnostic — Postgres carries it over the rename. No FK to drop here:
-- the legacy `whatsapp_sessions_schoolId_fkey` was already removed via
-- `drop_session_fk.sql` (and doesn't exist at all in the new worker-only
-- project since that DB never had FD's `schools` table to reference).
--
-- Apply via:
--   set -a; source .env; set +a
--   npx prisma db execute --file ./prisma/sql/rename_session_id.sql
-- Then update prisma/schema.prisma and run `npm run generate`.
--
-- Idempotent: only renames if the old column is still present.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_sessions'
      AND column_name = 'schoolId'
  ) THEN
    ALTER TABLE whatsapp_sessions RENAME COLUMN "schoolId" TO "sessionId";
  END IF;
END $$;
