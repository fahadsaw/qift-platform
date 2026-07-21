-- SETTLE-1 (Track C PR 2): PaymentReceipt + Store payout identity.
-- Additive only. Forward-only financial schema (FC Rule 13.8):
-- rollback = revert code; tables/columns remain.

-- AlterTable (SC §5.4/§13.4: payout identity verified before any
-- settlement eligibility; nullable — pre-SETTLE-1 stores unverified)
ALTER TABLE "Store" ADD COLUMN     "payoutIdentityEvidence" TEXT,
ADD COLUMN     "payoutIdentityVerifiedAt" TIMESTAMP(3);

-- CreateTable (FC Ch. 4.7 Payment Receipt document; occurrence entity
-- for invoice.payment.received:{receiptId})
CREATE TABLE "PaymentReceipt" (
    "id" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orgId" TEXT,
    "campaignId" TEXT,
    "storeId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "rail" TEXT NOT NULL DEFAULT 'manual_bank_transfer',
    "bankReference" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentReceipt_invoiceType_invoiceId_idx" ON "PaymentReceipt"("invoiceType", "invoiceId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_storeId_idx" ON "PaymentReceipt"("storeId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_campaignId_idx" ON "PaymentReceipt"("campaignId");

-- CreateIndex (SC §18.1 idempotency law: same bank transfer recorded
-- twice collides with the original)
CREATE UNIQUE INDEX "PaymentReceipt_invoiceType_invoiceId_bankReference_key" ON "PaymentReceipt"("invoiceType", "invoiceId", "bankReference");
