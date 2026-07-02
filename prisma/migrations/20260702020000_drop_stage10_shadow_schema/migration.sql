-- Reconcile the abandoned Stage-10 "shadow" schema.
--
-- CONTEXT: production accumulated a cluster of tables from an abandoned
-- Stage-10 migration lineage (folders 20260527..20260530) that was never
-- merged into the repo. Today's P3009 incident was caused by one of them
-- (FinancialLedgerEntry) colliding with a real migration. This migration
-- removes the abandoned cluster so production matches the canonical repo
-- and future financial work (MerchantOrder / RefundRequest / PaymentIntent
-- / PaymentAllocation / GiftSession) can define those names cleanly.
--
-- SAFETY (verified read-only before authoring):
--   * Every dropped table has ZERO rows.
--   * NO canonical/live table references the shadow cluster (proven: zero
--     inbound FKs from outside the cluster). CASCADE therefore only affects
--     shadow objects that are being dropped here anyway.
--   * `IF EXISTS` on every statement makes this a NO-OP on any fresh
--     environment (dev/staging/CI) that never had these tables — it only
--     reconciles production.
--   * RiskSignalEvent is NOT dropped — it holds one real telemetry row and
--     is archived (renamed) with its row preserved.
--   * Canonical tables and live business data are untouched.
--
-- BACKOUT: the full DDL of every object removed here is captured in
-- BACKOUT_DDL.sql alongside this file (reference reconstruction).

-- 1. Archive RiskSignalEvent (preserve its single row; do not drop).
ALTER TABLE IF EXISTS "RiskSignalEvent" RENAME TO "zz_legacy_RiskSignalEvent";
ALTER INDEX IF EXISTS "RiskSignalEvent_pkey" RENAME TO "zz_legacy_RiskSignalEvent_pkey";

-- 2. Drop the verified-empty, abandoned shadow tables. Ordered
--    child-before-parent for clarity; CASCADE is the safety net.
DROP TABLE IF EXISTS "GiftSessionRecipient" CASCADE;
DROP TABLE IF EXISTS "GiftSession" CASCADE;
DROP TABLE IF EXISTS "MerchantOrderRecipientShipment" CASCADE;
DROP TABLE IF EXISTS "MerchantOrderLineItem" CASCADE;
DROP TABLE IF EXISTS "MerchantOrder" CASCADE;
DROP TABLE IF EXISTS "PaymentAllocation" CASCADE;
DROP TABLE IF EXISTS "PaymentIntent" CASCADE;
DROP TABLE IF EXISTS "RecipientConfirmationRequest" CASCADE;
DROP TABLE IF EXISTS "RefundRequest" CASCADE;
DROP TABLE IF EXISTS "ShipmentLineItem" CASCADE;
DROP TABLE IF EXISTS "zz_legacy_FinancialLedgerEntry_shadow" CASCADE;

-- 3. Remove the 4 orphan migration-history records whose folders are not in
--    the repo (they recorded the shadow schema). Idempotent: deletes 0 rows
--    on a fresh DB. NOTE: the canonical `20260610120000_audit_log` is a
--    DIFFERENT name and is left untouched, as are the normal
--    rolled-back/reapplied pairs.
DELETE FROM "_prisma_migrations" WHERE migration_name IN (
  '20260527000000_audit_log',
  '20260528000000_risk_signal_event',
  '20260529000000_recipient_confirmation_request',
  '20260530000000_gift_session_topology'
);
