-- Replace Gift.merchantId with storeName (required) + message (optional).
-- SQLite ≥ 3.35 supports DROP COLUMN; the dev environment is on a recent
-- SQLite so this runs in-place without a table rebuild.

ALTER TABLE "Gift" ADD COLUMN "storeName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Gift" ADD COLUMN "message" TEXT;
ALTER TABLE "Gift" DROP COLUMN "merchantId";
