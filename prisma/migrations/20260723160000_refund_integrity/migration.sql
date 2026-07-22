-- Refund integrity (Track C PR 10, founder boundaries 2+3):
-- RefundRequest maker-checker workflow + CorporateInvoice.balanceStatus.
-- Additive; defaults land on rows whose balanceStatus semantics are
-- derivable (prod: gates closed, no credited invoices exist).
-- Forward-only (FC Rule 13.8).

-- AlterTable
ALTER TABLE "CorporateInvoice" ADD COLUMN     "balanceStatus" TEXT NOT NULL DEFAULT 'open';

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "storeId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "amount" DECIMAL(12,2) NOT NULL,
    "vatComponent" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "reasonCode" TEXT,
    "recipientType" TEXT NOT NULL DEFAULT 'company',
    "method" TEXT NOT NULL DEFAULT 'manual_bank_transfer',
    "snapshotHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'requested',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedBy" TEXT,
    "executedAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "refundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundRequest_refundId_key" ON "RefundRequest"("refundId");

-- CreateIndex
CREATE INDEX "RefundRequest_invoiceType_invoiceId_idx" ON "RefundRequest"("invoiceType", "invoiceId");

-- CreateIndex
CREATE INDEX "RefundRequest_state_idx" ON "RefundRequest"("state");

