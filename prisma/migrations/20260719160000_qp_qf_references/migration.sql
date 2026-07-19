-- Track A.5 PR 6: canonical personal-order (QP) + merchant-fulfillment
-- (QF) references. THIS backfill touches real production rows:
-- 11 Orders + 19 Gifts (verified read-only 2026-07-19). Same proven
-- pattern as QB/QG: additive -> loop-checked random backfill ->
-- NOT NULL -> unique index. Rollback = drop both columns + indexes.

ALTER TABLE "Order" ADD COLUMN "orderNumber" TEXT;
ALTER TABLE "Gift" ADD COLUMN "fulfillmentNumber" TEXT;

DO $$
DECLARE
  r RECORD;
  alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  body TEXT;
  candidate TEXT;
  i INT;
BEGIN
  FOR r IN SELECT "id" FROM "Order" WHERE "orderNumber" IS NULL LOOP
    LOOP
      body := '';
      FOR i IN 1..8 LOOP
        body := body || substr(alphabet, 1 + floor(random() * 31)::int, 1);
      END LOOP;
      candidate := 'QP-' || substr(body, 1, 4) || '-' || substr(body, 5, 4);
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "Order" WHERE "orderNumber" = candidate
      );
    END LOOP;
    UPDATE "Order" SET "orderNumber" = candidate WHERE "id" = r."id";
  END LOOP;

  FOR r IN SELECT "id" FROM "Gift" WHERE "fulfillmentNumber" IS NULL LOOP
    LOOP
      body := '';
      FOR i IN 1..8 LOOP
        body := body || substr(alphabet, 1 + floor(random() * 31)::int, 1);
      END LOOP;
      candidate := 'QF-' || substr(body, 1, 4) || '-' || substr(body, 5, 4);
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "Gift" WHERE "fulfillmentNumber" = candidate
      );
    END LOOP;
    UPDATE "Gift" SET "fulfillmentNumber" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET NOT NULL;
ALTER TABLE "Gift" ALTER COLUMN "fulfillmentNumber" SET NOT NULL;

CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE UNIQUE INDEX "Gift_fulfillmentNumber_key" ON "Gift"("fulfillmentNumber");
