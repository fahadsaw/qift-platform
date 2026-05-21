-- Phase 2.5a — product media foundation.
--
-- Adds the three columns the new product-image upload endpoint +
-- ProductsService gallery sync need. All three columns are
-- nullable / optional — every existing Product / ProductImage row
-- is unaffected.
--
-- Schema deltas:
--   Product.videoUrl        — optional product video URL (no UI
--                              consumes it yet during closed beta;
--                              gated by a frontend feature flag).
--   Product.videoType       — discriminator for the future video
--                              renderer ('mp4' | 'webm' | 'mov').
--   ProductImage.imageMeta  — sparse per-image metadata (width,
--                              height, MIME, alt text, etc.).
--                              Forward-compat: 2.5a uploads do
--                              NOT populate this yet — server-side
--                              dimension extraction is deferred
--                              until storefront gallery rendering
--                              actually needs it (Phase 2.5c).
--
-- All three are metadata-only ADD COLUMN ops on PostgreSQL —
-- instant, no table rewrite, no downtime. Safe to run on any
-- closed-beta deploy.

ALTER TABLE "Product"
  ADD COLUMN "videoUrl"  TEXT,
  ADD COLUMN "videoType" TEXT;

ALTER TABLE "ProductImage"
  ADD COLUMN "imageMeta" JSONB;
