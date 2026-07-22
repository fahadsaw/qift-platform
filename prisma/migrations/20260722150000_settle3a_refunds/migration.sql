-- SETTLE-3a (Track C PR 5): refunds — SettlementRefund + CreditNote +
-- SettlementReceivable (SC §8, FC Ch. 4.5). Additive only.
-- Forward-only (FC Rule 13.8): rollback = revert code; tables remain.

-- CreateTable
CREATE TABLE "SettlementRefund" (
    "id" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "amount" DECIMAL(12,2) NOT NULL,
    "vatComponent" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceRef" TEXT NOT NULL,
    "refundedAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "settlementInteraction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "noteType" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "merchantInvoiceNumber" TEXT,
    "merchantCreditNoteNumber" TEXT,
    "storeId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "amount" DECIMAL(12,2) NOT NULL,
    "vatComponent" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementReceivable" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "amount" DECIMAL(12,2) NOT NULL,
    "occurrenceType" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "accruedAt" TIMESTAMP(3) NOT NULL,
    "recoveredAt" TIMESTAMP(3),
    "recoveredBySettlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementReceivable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementRefund_invoiceType_invoiceId_idx" ON "SettlementRefund"("invoiceType", "invoiceId");

-- CreateIndex
CREATE INDEX "SettlementRefund_storeId_idx" ON "SettlementRefund"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRefund_invoiceType_invoiceId_evidenceRef_key" ON "SettlementRefund"("invoiceType", "invoiceId", "evidenceRef");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_refundId_key" ON "CreditNote"("refundId");

-- CreateIndex
CREATE INDEX "CreditNote_invoiceType_invoiceId_idx" ON "CreditNote"("invoiceType", "invoiceId");

-- CreateIndex
CREATE INDEX "SettlementReceivable_storeId_state_idx" ON "SettlementReceivable"("storeId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReceivable_occurrenceType_occurrenceId_key" ON "SettlementReceivable"("occurrenceType", "occurrenceId");

