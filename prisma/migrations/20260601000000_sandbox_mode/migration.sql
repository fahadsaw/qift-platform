-- Closed-beta sandbox simulation. Adds `isSandbox` to Order, Gift,
-- and PayoutEvent. The flag is the single load-bearing primitive
-- separating "test order that walked the full lifecycle" from
-- "real order that captured money."
--
-- Default is FALSE on every column. This is deliberately the safer
-- production-default: a write that omits the field is treated as
-- live. Closed-beta deploys force the flag server-side via the
-- SANDBOX_ONLY_MODE=true env var (see src/payments/sandbox-mode.ts);
-- a missing env var on production therefore cannot silently turn
-- a real deploy into sandbox or vice versa.
--
-- All three ADD COLUMN statements are metadata-only on PostgreSQL
-- (NOT NULL DEFAULT false on an existing table). No table rewrite,
-- no downtime. The three indices are small (low-cardinality leading
-- boolean) and build cheaply; closed-beta volumes are well under
-- the threshold where CREATE INDEX CONCURRENTLY is needed.

ALTER TABLE "Order"
  ADD COLUMN "isSandbox" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Gift"
  ADD COLUMN "isSandbox" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PayoutEvent"
  ADD COLUMN "isSandbox" BOOLEAN NOT NULL DEFAULT false;

-- Admin "Sandbox / Live / All" filter on the orders list.
CREATE INDEX "Order_isSandbox_status_idx"
  ON "Order"("isSandbox", "status");

-- Admin gift-list filter + future merchant-side sandbox filtering.
-- Created-at is the natural secondary order for the list view.
CREATE INDEX "Gift_isSandbox_status_createdAt_idx"
  ON "Gift"("isSandbox", "status", "createdAt");

-- Finance ledger reads filter (isSandbox = false) by default —
-- this index turns that into a bounded range scan.
CREATE INDEX "PayoutEvent_isSandbox_occurredAt_idx"
  ON "PayoutEvent"("isSandbox", "occurredAt");
