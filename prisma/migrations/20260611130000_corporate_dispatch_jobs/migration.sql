-- Corporate Foundation PR 4: DispatchJob queue.
--
-- PURELY ADDITIVE: one new table + indexes + one FK to
-- "GiftCampaign" (CASCADE). No existing table, column, or row is
-- touched. Reversible with:
--   DROP TABLE "DispatchJob";
--
-- Structural notes (Corporate Core v2 §5):
--   * "idempotencyKey" (campaignId:contactId) is UNIQUE — a
--     recipient can never receive two jobs for the same wave.
--   * "contactId" is plain TEXT (no FK to "CorporateContact"):
--     jobs are the dispatch ledger and survive contact purges; the
--     row carries no PII (channel values are read live at
--     processing time, never copied).

-- CreateTable
CREATE TABLE "DispatchJob" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimRef" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchJob_idempotencyKey_key" ON "DispatchJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DispatchJob_status_createdAt_idx" ON "DispatchJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DispatchJob_campaignId_status_idx" ON "DispatchJob"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "DispatchJob" ADD CONSTRAINT "DispatchJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GiftCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
