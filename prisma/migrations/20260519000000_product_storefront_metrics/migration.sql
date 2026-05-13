-- Phase 5: storefront metrics-on-the-wire.
--
-- Adds two denormalized counters on Product so the storefront's
-- per-product metric projection (`projectStorefrontMetrics`) can
-- answer "how many times has this been gifted?" and "is this
-- trending?" without joining Gift / Wish on every storefront read.
--
--   giftedByCount  — incremented atomically by GiftsService.create()
--                    when the gift carries a productId.
--   trendingAt     — set by WishesService when a heart crosses the
--                    `TRENDING_HEART_THRESHOLD` (recently active
--                    products), and by GiftsService when a gift is
--                    created against the product. The projection
--                    treats `trendingAt > NOW() - 7 days` as trending.
--
-- Backfill (idempotent — re-running this migration would zero-out
-- the columns and refill from current Gift rows). The COUNT excludes
-- cancelled gifts so the historical value matches the runtime
-- increment rule.
ALTER TABLE "Product"
  ADD COLUMN "giftedByCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "trendingAt" TIMESTAMP(3);

-- Backfill giftedByCount from existing Gift rows. Counts every
-- gift that's not currently in a cancelled terminal state, since
-- a cancellation reverses both the wishlist deactivation and the
-- "this product was gifted" implication.
UPDATE "Product" p
SET "giftedByCount" = (
  SELECT COUNT(*)::int FROM "Gift" g
  WHERE g."productId" = p.id AND g.status <> 'cancelled'
);

-- Index for "trending now" lookups. The projection compares
-- trendingAt against (NOW - window) so a btree on trendingAt is
-- the right shape — ascending range scan from the threshold.
CREATE INDEX "Product_trendingAt_idx" ON "Product"("trendingAt");
