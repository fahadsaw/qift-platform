-- Corporate Foundation PR 3: GiftCampaign + CampaignGiftOption +
-- CampaignRecipient.
--
-- PURELY ADDITIVE: three new tables + indexes + FKs. No existing
-- table, column, or row is touched. Reversible with:
--   DROP TABLE "CampaignRecipient";
--   DROP TABLE "CampaignGiftOption";
--   DROP TABLE "GiftCampaign";
--
-- Structural notes (Corporate Core v2 §4):
--   * createdBy / approvedBy / cancelledBy on "GiftCampaign" are
--     plain TEXT (no FK to "User") — purge survivability.
--   * "CampaignRecipient".contactId CASCADEs from
--     "CorporateContact": purged contacts vanish from recipient
--     lists; active campaigns are protected upstream (the purge
--     worker skips contacts in pending_approval/approved/
--     dispatching campaigns).
--   * "CampaignGiftOption".approvalSnapshot (JSONB) freezes the
--     approved product + store identity at approval time.

-- CreateTable
CREATE TABLE "GiftCampaign" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "occasion" TEXT,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignGiftOption" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "approvalSnapshot" JSONB,
    "snapshotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignGiftOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCampaign_orgId_status_idx" ON "GiftCampaign"("orgId", "status");

-- CreateIndex
CREATE INDEX "CampaignGiftOption_campaignId_idx" ON "CampaignGiftOption"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_contactId_key" ON "CampaignRecipient"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_contactId_idx" ON "CampaignRecipient"("contactId");

-- AddForeignKey
ALTER TABLE "GiftCampaign" ADD CONSTRAINT "GiftCampaign_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignGiftOption" ADD CONSTRAINT "CampaignGiftOption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GiftCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GiftCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CorporateContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
