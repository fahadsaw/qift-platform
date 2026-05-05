-- Gift v3: full tracking pipeline.
--   1. Add per-step timestamps + optional tracking number/carrier columns.
--   2. Add a (status, createdAt) index for the 24h auto-default sweep.
--   3. Migrate the legacy `ready_for_delivery` bucket onto the new
--      `address_confirmed` name and backfill confirmedAt from createdAt
--      so existing rows still render on the timeline.

ALTER TABLE "Gift" ADD COLUMN "confirmedAt"    DATETIME;
ALTER TABLE "Gift" ADD COLUMN "shippedAt"      DATETIME;
ALTER TABLE "Gift" ADD COLUMN "deliveredAt"    DATETIME;
ALTER TABLE "Gift" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "Gift" ADD COLUMN "carrier"        TEXT;

CREATE INDEX "Gift_status_createdAt_idx" ON "Gift"("status", "createdAt");

-- Legacy → new status name. We don't touch `pending_address`, `preparing`,
-- or `delivered` because their names didn't change.
UPDATE "Gift" SET "status" = 'address_confirmed' WHERE "status" = 'ready_for_delivery';

-- Backfill timestamps so the timeline renders correctly for older rows.
UPDATE "Gift" SET "confirmedAt" = "createdAt"
  WHERE "confirmedAt" IS NULL
    AND "status" IN ('address_confirmed', 'preparing', 'shipped', 'delivered');
UPDATE "Gift" SET "shippedAt"   = "createdAt"
  WHERE "shippedAt" IS NULL
    AND "status" IN ('shipped', 'delivered');
UPDATE "Gift" SET "deliveredAt" = "createdAt"
  WHERE "deliveredAt" IS NULL
    AND "status" = 'delivered';
