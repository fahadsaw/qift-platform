-- Align the AuditLog model with production reality (PR 11).
--
-- Production's AuditLog table predated the 20260610120000_audit_log
-- migration (it was created out-of-band by the week2-era audit
-- experiment, recovered via `migrate resolve --applied` after the
-- P3009 incident). It differs from the migration-created shape in
-- two ways: actorUserId is NULLABLE (109 legacy rows carry NULL)
-- and two extra hash columns exist. This migration makes every
-- environment converge on that superset shape.
--
-- IDEMPOTENT BY CONSTRUCTION so it succeeds on BOTH topologies:
--   - production (column nullable + extras already present)
--   - fresh databases built from the 20260610120000 migration
-- DROP NOT NULL is a no-op on an already-nullable column;
-- ADD COLUMN IF NOT EXISTS skips existing columns. Purely additive
-- — no data is touched, nothing is dropped.

ALTER TABLE "AuditLog" ALTER COLUMN "actorUserId" DROP NOT NULL;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "ipHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "userAgentHash" TEXT;
