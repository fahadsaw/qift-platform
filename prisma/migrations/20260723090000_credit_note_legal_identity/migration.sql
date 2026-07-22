-- Credit-note legal identity + append-only versions (Track C PR 8,
-- founder legal-document integrity check). NOT NULL defaults land on
-- a structurally empty table (prod verified 0 rows; gates closed).
-- Additive, forward-only (FC Rule 13.8).

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "creditNoteUuid" TEXT,
ADD COLUMN     "currentVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "issuanceSource" TEXT NOT NULL DEFAULT 'MERCHANT',
ADD COLUMN     "issuerType" TEXT NOT NULL DEFAULT 'MERCHANT',
ADD COLUMN     "onBehalfAuthorizationRef" TEXT,
ADD COLUMN     "originalInvoiceNumber" TEXT;

-- CreateTable
CREATE TABLE "CreditNoteVersion" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "changeReason" TEXT NOT NULL,
    "canonicalJson" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "statementSettlementId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditNoteVersion_creditNoteId_idx" ON "CreditNoteVersion"("creditNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteVersion_creditNoteId_versionNumber_key" ON "CreditNoteVersion"("creditNoteId", "versionNumber");

