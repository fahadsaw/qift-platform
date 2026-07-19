-- Track A.5 PR 2: canonical business-purchase reference (QB-XXXX-XXXX)
-- on GiftCampaign. Additive -> backfill -> constrain; rollback = drop
-- the column + index. Production has ZERO GiftCampaign rows (verified
-- read-only 2026-07-19), so the backfill below exists for dev/CI
-- databases and for correctness.

-- AlterTable (additive, nullable first)
ALTER TABLE "GiftCampaign" ADD COLUMN "referenceNumber" TEXT;

-- Backfill: alphabet-conformant random references (31 symbols, no
-- 0/O/1/I/L), loop-checked for uniqueness within the table.
DO $$
DECLARE
  r RECORD;
  alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  body TEXT;
  candidate TEXT;
  i INT;
BEGIN
  FOR r IN SELECT "id" FROM "GiftCampaign" WHERE "referenceNumber" IS NULL LOOP
    LOOP
      body := '';
      FOR i IN 1..8 LOOP
        body := body || substr(alphabet, 1 + floor(random() * 31)::int, 1);
      END LOOP;
      candidate := 'QB-' || substr(body, 1, 4) || '-' || substr(body, 5, 4);
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "GiftCampaign" WHERE "referenceNumber" = candidate
      );
    END LOOP;
    UPDATE "GiftCampaign" SET "referenceNumber" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

-- Constrain
ALTER TABLE "GiftCampaign" ALTER COLUMN "referenceNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "GiftCampaign_referenceNumber_key" ON "GiftCampaign"("referenceNumber");
