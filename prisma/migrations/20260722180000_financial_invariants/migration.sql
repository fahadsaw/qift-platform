-- Financial invariants (Track C PR 6, RC v3.0): CreditNote becomes a
-- FIRST-CLASS document (QN reference, canonical JSON, hash, statement
-- relationship); SettlementReceivable becomes a lifecycle entity
-- (amountRecovered; states law in code). NOT NULL columns land on
-- structurally empty tables (gates closed — no credit notes can exist
-- before attestation). Additive, forward-only (FC Rule 13.8).

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "canonicalJson" TEXT NOT NULL,
ADD COLUMN     "documentHash" TEXT NOT NULL,
ADD COLUMN     "referenceNumber" TEXT NOT NULL,
ADD COLUMN     "statementSettlementId" TEXT;

-- AlterTable
ALTER TABLE "SettlementReceivable" ADD COLUMN     "amountRecovered" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_referenceNumber_key" ON "CreditNote"("referenceNumber");

