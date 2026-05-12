-- Wishlist first-class — product-linked entries with denormalized
-- snapshots. Backwards-compatible: existing free-text rows
-- (`title` + optional `store` string) keep working untouched;
-- every new column is nullable so the in-place ALTER doesn't
-- require a backfill.
--
-- Uniqueness: `@@unique([userId, productId])` guarantees a single
-- wishlist row per (user, product). Postgres treats NULLs as
-- distinct, so legacy rows (productId IS NULL) are unaffected
-- and multiple legacy rows per user remain allowed.
--
-- Denormalized counter on Product (`wishlistedByCount`) starts
-- at 0; WishesService increments on upsert-insert and decrements
-- on delete in the same transaction.

-- ── Wish additions ──────────────────────────────────────────
ALTER TABLE "Wish" ADD COLUMN "productId"         TEXT;
ALTER TABLE "Wish" ADD COLUMN "storeId"           TEXT;
ALTER TABLE "Wish" ADD COLUMN "productName"       TEXT;
ALTER TABLE "Wish" ADD COLUMN "storeName"         TEXT;
ALTER TABLE "Wish" ADD COLUMN "imageUrl"          TEXT;
ALTER TABLE "Wish" ADD COLUMN "price"             DOUBLE PRECISION;
ALTER TABLE "Wish" ADD COLUMN "currency"          TEXT;
ALTER TABLE "Wish" ADD COLUMN "deactivatedAt"     TIMESTAMP(3);
ALTER TABLE "Wish" ADD COLUMN "deactivatedReason" TEXT;
ALTER TABLE "Wish" ADD COLUMN "updatedAt"         TIMESTAMP(3) NOT NULL
  DEFAULT CURRENT_TIMESTAMP;

-- Drop the default on updatedAt after backfill so future writes
-- must use Prisma's @updatedAt (which always sets it).
ALTER TABLE "Wish" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- FKs. ON DELETE SET NULL preserves the wishlist row when the
-- product/store is later deleted — the deactivation cascade is
-- the application-layer responsibility (set `deactivatedAt` in
-- the same transaction as the product delete).
ALTER TABLE "Wish"
  ADD CONSTRAINT "Wish_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Wish"
  ADD CONSTRAINT "Wish_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- One wishlist row per (userId, productId). Postgres NULL
-- semantics: rows with productId IS NULL are considered
-- distinct, so legacy free-text rows are unaffected.
CREATE UNIQUE INDEX "Wish_userId_productId_key"
  ON "Wish"("userId", "productId");

-- "N people want this" aggregate query.
CREATE INDEX "Wish_productId_idx" ON "Wish"("productId");

-- ── Product denormalized counter ────────────────────────────
ALTER TABLE "Product" ADD COLUMN "wishlistedByCount" INTEGER NOT NULL DEFAULT 0;
