-- GiftPost completion — Phase 4 of the staged roadmap.
--
-- Three coupled changes that land together:
--
-- 1) Product gallery (new ProductImage model).
--    Many products naturally carry multiple media (perfumes, flowers,
--    jewelry, gift sets). The GiftPost viewer already accepts a
--    `string[]` so once this lands, horizontal swipe inside a gift
--    is real instead of pass-through.
--    Backfill: every existing `Product.imageUrl` becomes the
--    first ProductImage row (displayOrder = 0). `Product.imageUrl`
--    is retained as the "primary image" snapshot for fast reads and
--    for the wishlist denormalized field; ProductImage is the
--    authoritative gallery source. No binary copy anywhere — the
--    single-source-of-truth rule from `project_product_media_single_source`.
--
-- 2) GiftPost composite uniqueness.
--    Currently `GiftPost.giftId @unique` — one post per gift. Both
--    parties can't publish their own perspective. We drop the
--    single-column unique constraint and add `@@unique([giftId,
--    ownerUserId])` — one post per (gift, owner). This lets the
--    sender AND the receiver each independently publish their own
--    gifting moment (privacy-preserved by the existing
--    buildGiftPostView).
--
-- 3) No new column for dedup `eventCount`.
--    V1 dedup is a QUERY-LAYER concern (grouping in listMine /
--    listByUser projection). Each GiftPost row stays per-gift; the
--    wall surface collapses by (ownerUserId, direction, productId)
--    and renders the most recent row with an ×N badge. The
--    individual post slug routes still resolve to specific events
--    — dedup is presentation, not storage. If we ever move to
--    storage-level dedup, this migration's choice is reversible.

-- ── Step 1: ProductImage model ──────────────────────────────
CREATE TABLE "ProductImage" (
  "id"           TEXT         NOT NULL,
  "productId"    TEXT         NOT NULL,
  "url"          TEXT         NOT NULL,
  "displayOrder" INTEGER      NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductImage_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- One image per (product, displayOrder) — prevents two images
-- claiming the same slot. ProductService writes ensure consecutive
-- ordering, but the constraint is a defensive guard.
CREATE UNIQUE INDEX "ProductImage_productId_displayOrder_key"
  ON "ProductImage"("productId", "displayOrder");

-- Gallery read path: list a product's images ordered by displayOrder.
CREATE INDEX "ProductImage_productId_idx"
  ON "ProductImage"("productId");

-- ── Step 2: Backfill from Product.imageUrl ──────────────────
INSERT INTO "ProductImage" ("id", "productId", "url", "displayOrder", "createdAt")
SELECT
  -- Stable cuid-shaped id derived from the productId so re-running
  -- the backfill (in a non-production environment) doesn't create
  -- duplicates. The composite unique on (productId, displayOrder)
  -- protects us too, but using a deterministic id keeps the rows
  -- referenceable across replays.
  'pi_' || substring("id", 1, 22),
  "id",
  "imageUrl",
  0,
  COALESCE("createdAt", CURRENT_TIMESTAMP)
FROM "Product"
WHERE "imageUrl" IS NOT NULL AND "imageUrl" <> '';

-- ── Step 3: GiftPost composite uniqueness ───────────────────
-- Drop the single-column unique constraint.
ALTER TABLE "GiftPost"
  DROP CONSTRAINT IF EXISTS "GiftPost_giftId_key";

-- The implicit unique index travels with the constraint on Postgres,
-- but on some Prisma-managed setups the index name survives. Drop
-- defensively (IF EXISTS prevents a hard fail when it's already gone).
DROP INDEX IF EXISTS "GiftPost_giftId_key";

-- New composite unique. One GiftPost per (gift, owner) — sender and
-- receiver can each have their own post on the same Gift.
CREATE UNIQUE INDEX "GiftPost_giftId_ownerUserId_key"
  ON "GiftPost"("giftId", "ownerUserId");
