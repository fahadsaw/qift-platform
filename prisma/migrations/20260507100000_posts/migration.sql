-- CreateTable: Post — profile-feed item with one media + optional caption.
-- Cascades on user deletion so a deleted account doesn't leave orphan posts.
CREATE TABLE "Post" (
    "id"        TEXT          NOT NULL,
    "userId"    TEXT          NOT NULL,
    "mediaUrl"  TEXT          NOT NULL,
    "mediaType" TEXT          NOT NULL,
    "caption"   TEXT,
    "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: hot path is "list a user's posts newest-first".
CREATE INDEX "Post_userId_createdAt_idx" ON "Post"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Post"
ADD CONSTRAINT "Post_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
