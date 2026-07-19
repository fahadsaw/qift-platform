-- Track B3 / PE-12: VAT-facts maker-checker proposal table.
-- Implements: Financial Constitution Ch. 14.1 (matrix row "merchant
-- VAT facts | Ops | Verification evidence + second person | Audited
-- config change") + Ch. 14.2 (two-person integrity) + Ch. 21
-- pre-authorized MODIFY ("Store VAT facts: KEEP; MODIFY: ops admin
-- toggle"). Additive only. Prod Store rows: 8 (untouched); this table
-- starts empty. ROLLBACK: forward-only financial schema — revert
-- application code; the empty table remains.

CREATE TABLE "StoreVatFactsProposal" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "vatRegistered" BOOLEAN NOT NULL,
    "vatNumber" TEXT,
    "pricesIncludeVat" BOOLEAN NOT NULL,
    "taxCountry" TEXT NOT NULL DEFAULT 'SA',
    "evidenceNote" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreVatFactsProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StoreVatFactsProposal_storeId_status_idx" ON "StoreVatFactsProposal"("storeId", "status");
