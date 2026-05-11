-- Gift-centric social posts (foundation only).
--
-- A GiftPost is the optional, opt-in publication of an existing
-- Gift to Qift's social surfaces. The Gift always exists when
-- the gifting event happens; this table only carries rows for
-- gifts the user chose to share.
--
-- Backwards-compatible: the table starts empty. No existing
-- Gift gains a row; counters (`giftsSent` / `giftsReceived`)
-- continue to derive from Gift rows directly and ignore this
-- table entirely.
--
-- Privacy defaults:
--   visibility       = 'private'
--   revealSender     = false
--   revealRecipient  = false
--
-- See the GiftPost model comment in schema.prisma for the full
-- philosophy + future self-purchase path.

CREATE TABLE "GiftPost" (
  "id"                TEXT         NOT NULL,
  "giftId"            TEXT         NOT NULL,
  "publishedAt"       TIMESTAMP(3),
  "visibility"        TEXT         NOT NULL DEFAULT 'private',
  "revealSender"      BOOLEAN      NOT NULL DEFAULT false,
  "revealRecipient"   BOOLEAN      NOT NULL DEFAULT false,
  "deactivatedAt"     TIMESTAMP(3),
  "deactivatedReason" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GiftPost_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "GiftPost_giftId_fkey" FOREIGN KEY ("giftId")
    REFERENCES "Gift"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One post per gift. The opt-in publish flow upserts on giftId.
CREATE UNIQUE INDEX "GiftPost_giftId_key" ON "GiftPost"("giftId");

-- Feed query — published public posts ordered by publishedAt DESC.
-- DB-engine-agnostic ordering happens at query time; the index
-- covers the lookup side.
CREATE INDEX "GiftPost_visibility_publishedAt_idx"
  ON "GiftPost"("visibility", "publishedAt");

-- Deactivation sweep — `deactivatedAt IS NULL` is the common
-- filter on the feed query.
CREATE INDEX "GiftPost_deactivatedAt_idx" ON "GiftPost"("deactivatedAt");
