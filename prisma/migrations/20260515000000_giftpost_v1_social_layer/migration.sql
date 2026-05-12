-- GiftPost V1 — first user-facing social layer.
--
-- The 20260513 migration laid the structural foundation
-- (one row per gift, opt-in publishing, visibility tiers,
-- identity reveal flags). V1 adds the columns + the
-- appreciation table needed for the first real social
-- surface to ship:
--
--   - `ownerUserId`        — the post's owner (sender side
--                            or receiver side). Stored
--                            explicitly so the Gift Wall is
--                            a simple `WHERE ownerUserId`
--                            scan instead of joining Gift.
--   - `direction`          — 'sent' | 'received' | 'self'.
--                            V1 populates it on every row;
--                            future dedup work consumes it.
--   - `publicSlug`         — short, opaque, non-enumerable
--                            token for /p/<slug> share URLs.
--                            Generated at first publish, then
--                            reused across publish/unpublish
--                            cycles so live shares don't 404
--                            after a momentary unpublish.
--   - `appreciationCount`  — denormalized 👍 count. Updated
--                            transactionally with the
--                            GiftPostAppreciation row writes.
--
-- Backfill: every existing GiftPost row gets its
-- ownerUserId + direction derived from the linked Gift.
-- For V1 we mirror the producer side (sender) — the
-- 20260513 migration created the table empty, so in
-- practice this UPDATE matches zero rows on a clean
-- environment. The UPDATE is here so dev databases that
-- happened to have seed rows don't break the NOT NULL
-- constraint.

-- ── Step 1: nullable columns first (so backfill can run) ──
ALTER TABLE "GiftPost"
  ADD COLUMN "ownerUserId"       TEXT,
  ADD COLUMN "direction"         TEXT,
  ADD COLUMN "publicSlug"        TEXT,
  ADD COLUMN "appreciationCount" INTEGER NOT NULL DEFAULT 0;

-- ── Step 2: backfill from Gift ──
-- Owner = sender side for V1 (matches the publish CTA
-- entry point on /gifts/[id] for the sender). Direction
-- mirrors that ('sent').
UPDATE "GiftPost" gp
   SET "ownerUserId" = g."senderId",
       "direction"   = 'sent'
  FROM "Gift" g
 WHERE gp."giftId" = g."id"
   AND gp."ownerUserId" IS NULL;

-- ── Step 3: lock down NOT NULL on the populated columns ──
ALTER TABLE "GiftPost"
  ALTER COLUMN "ownerUserId" SET NOT NULL,
  ALTER COLUMN "direction"   SET NOT NULL;

-- ── Step 4: FK + indexes for the new columns ──
ALTER TABLE "GiftPost"
  ADD CONSTRAINT "GiftPost_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Gift Wall query: `WHERE ownerUserId = :u
--                     AND publishedAt IS NOT NULL
--                     AND deactivatedAt IS NULL`
-- ordered by publishedAt DESC.
CREATE INDEX "GiftPost_ownerUserId_publishedAt_idx"
  ON "GiftPost"("ownerUserId", "publishedAt");

-- /p/<slug> route lookup. Unique so the slug is never reused
-- across distinct posts; nullable so unpublished-but-never-
-- published rows can exist without burning slug space.
CREATE UNIQUE INDEX "GiftPost_publicSlug_key"
  ON "GiftPost"("publicSlug");

-- ── Step 5: appreciation table ──
--
-- Per-user 👍 on a post. Composite-unique so each user can
-- only appreciate a post once (no spam-tapping the counter).
-- Counter writes happen in the same transaction as
-- row create/delete — same pattern as Wish +
-- Product.wishlistedByCount.
--
-- Privacy: aggregate-only on public surfaces. The roster of
-- who appreciated is owner-visible only — never exposed to
-- third parties. (See `feedback_no_generic_social` /
-- `project_interaction_philosophy`.)
CREATE TABLE "GiftPostAppreciation" (
  "id"         TEXT         NOT NULL,
  "giftPostId" TEXT         NOT NULL,
  "userId"     TEXT         NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GiftPostAppreciation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GiftPostAppreciation_giftPostId_fkey"
    FOREIGN KEY ("giftPostId") REFERENCES "GiftPost"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GiftPostAppreciation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- One appreciation per (post, user). The toggle endpoint
-- upserts; the DB enforces the invariant.
CREATE UNIQUE INDEX "GiftPostAppreciation_giftPostId_userId_key"
  ON "GiftPostAppreciation"("giftPostId", "userId");

-- "Posts I've appreciated" — secondary scan, useful for
-- future profile surfaces.
CREATE INDEX "GiftPostAppreciation_userId_idx"
  ON "GiftPostAppreciation"("userId");
