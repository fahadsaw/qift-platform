-- Corporate Foundation PR 5: ClaimableGift + ClaimAddress.
--
-- PURELY ADDITIVE: two new tables + indexes + FKs. No existing
-- table, column, or row is touched. Reversible with:
--   DROP TABLE "ClaimAddress";
--   DROP TABLE "ClaimableGift";
--
-- Structural notes (Corporate Core v2 §6):
--   * "tokenHash" UNIQUE — the raw claim token never persists.
--   * recipient identity / org name / gift snapshot live on the
--     claim row (mint-time snapshots) and are revealed only after
--     OTP verification (F1: nothing identifying before OTP).
--   * "ClaimAddress" is write-only from the claim flow: no API
--     endpoint returns it to any org, merchant, or consumer
--     surface. The company never sees employee addresses.
--   * "contactId" is plain TEXT (no FK) — purge-survivable linkage.

-- CreateTable
CREATE TABLE "ClaimableGift" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "jobId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "recipientName" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channelValue" TEXT NOT NULL,
    "orgDisplayName" TEXT NOT NULL,
    "campaignMessage" TEXT,
    "giftSnapshot" JSONB NOT NULL,
    "sessionTokenHash" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "otpVerifiedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimableGift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimAddress" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "fullName" TEXT,
    "phone" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "region" TEXT,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "line1" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimableGift_jobId_key" ON "ClaimableGift"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimableGift_tokenHash_key" ON "ClaimableGift"("tokenHash");

-- CreateIndex
CREATE INDEX "ClaimableGift_campaignId_status_idx" ON "ClaimableGift"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimAddress_claimId_key" ON "ClaimAddress"("claimId");

-- AddForeignKey
ALTER TABLE "ClaimableGift" ADD CONSTRAINT "ClaimableGift_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GiftCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimAddress" ADD CONSTRAINT "ClaimAddress_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClaimableGift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
