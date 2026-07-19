-- Track A.5 PR 3: canonical recipient-gift reference (QG-XXXX-XXXX) on
-- ClaimableGift. Additive -> backfill -> constrain; rollback = drop
-- column + index. Production has ZERO ClaimableGift rows (verified
-- read-only 2026-07-19); backfill exists for dev/CI databases.

ALTER TABLE "ClaimableGift" ADD COLUMN "giftReference" TEXT;

DO $$
DECLARE
  r RECORD;
  alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  body TEXT;
  candidate TEXT;
  i INT;
BEGIN
  FOR r IN SELECT "id" FROM "ClaimableGift" WHERE "giftReference" IS NULL LOOP
    LOOP
      body := '';
      FOR i IN 1..8 LOOP
        body := body || substr(alphabet, 1 + floor(random() * 31)::int, 1);
      END LOOP;
      candidate := 'QG-' || substr(body, 1, 4) || '-' || substr(body, 5, 4);
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "ClaimableGift" WHERE "giftReference" = candidate
      );
    END LOOP;
    UPDATE "ClaimableGift" SET "giftReference" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

ALTER TABLE "ClaimableGift" ALTER COLUMN "giftReference" SET NOT NULL;

CREATE UNIQUE INDEX "ClaimableGift_giftReference_key" ON "ClaimableGift"("giftReference");
