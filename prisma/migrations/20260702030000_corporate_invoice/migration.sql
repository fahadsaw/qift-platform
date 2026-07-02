-- PR 4: CorporateInvoice — the first corporate money entity.
--
-- PURELY ADDITIVE: one new table + indexes. No existing table, column,
-- or row is touched. Reversible with:
--   DROP TABLE "CorporateInvoice";
--
-- Structural notes:
--   * NO foreign keys. "orgId" and "campaignId" are plain TEXT so the
--     invoice survives the purge of the org/campaign it bills
--     (regulatory retention) — same posture as AuditLog / FinancialLedger.
--   * "campaignId" UNIQUE is the idempotency anchor: exactly one invoice
--     per campaign, so a retried approval/dispatch cannot duplicate it.
--   * Money columns are DOUBLE PRECISION (Prisma Float) to match the
--     existing Order / Payment / FinancialLedgerEntry money columns.

-- CreateTable
CREATE TABLE "CorporateInvoice" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "recipientCount" INTEGER NOT NULL,
    "unitAmount" DOUBLE PRECISION NOT NULL,
    "subtotalAmount" DOUBLE PRECISION NOT NULL,
    "platformFeeAmount" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "CorporateInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CorporateInvoice_campaignId_key" ON "CorporateInvoice"("campaignId");

-- CreateIndex
CREATE INDEX "CorporateInvoice_orgId_idx" ON "CorporateInvoice"("orgId");

-- CreateIndex
CREATE INDEX "CorporateInvoice_status_createdAt_idx" ON "CorporateInvoice"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CorporateInvoice_issuedAt_idx" ON "CorporateInvoice"("issuedAt");
