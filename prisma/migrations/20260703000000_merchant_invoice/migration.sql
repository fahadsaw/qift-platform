-- MerchantInvoice — the GOODS-leg invoice (agent model).
--
-- PURELY ADDITIVE: one new table + indexes. No existing table, column,
-- or row is touched. Reversible with:
--   DROP TABLE "MerchantInvoice";
--
-- Structural notes:
--   * Qift is an AGENT: the merchant is the legal seller of the goods.
--     This table records the merchant's sale to the company (goods +
--     merchant VAT). Qift generates/stores the record on the merchant's
--     behalf; the amounts are MERCHANT revenue, never Qift's. The Qift
--     service invoice (CorporateInvoice) stays fee-only.
--   * NO foreign keys. "storeId", "orgId" and "campaignId" are plain
--     TEXT so the invoice survives store/org/campaign purges
--     (regulatory retention) — same posture as CorporateInvoice /
--     AuditLog / FinancialLedgerEntry.
--   * ("campaignId", "storeId") UNIQUE is the idempotency anchor: one
--     merchant invoice per campaign/store, so a retried approval cannot
--     duplicate it. Its leading column also serves campaignId lookups,
--     so no separate campaignId index is needed.
--   * Money columns are DOUBLE PRECISION (Prisma Float) to match the
--     existing CorporateInvoice / FinancialLedgerEntry money columns.

-- CreateTable
CREATE TABLE "MerchantInvoice" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "storeId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "recipientCount" INTEGER NOT NULL,
    "unitAmount" DOUBLE PRECISION NOT NULL,
    "goodsSubtotalAmount" DOUBLE PRECISION NOT NULL,
    "vatRate" DOUBLE PRECISION NOT NULL,
    "vatAmount" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT false,
    "taxTreatment" TEXT NOT NULL,
    "taxSnapshot" JSONB,
    "issuedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "MerchantInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantInvoice_campaignId_storeId_key" ON "MerchantInvoice"("campaignId", "storeId");

-- CreateIndex
CREATE INDEX "MerchantInvoice_storeId_idx" ON "MerchantInvoice"("storeId");

-- CreateIndex
CREATE INDEX "MerchantInvoice_orgId_idx" ON "MerchantInvoice"("orgId");

-- CreateIndex
CREATE INDEX "MerchantInvoice_status_createdAt_idx" ON "MerchantInvoice"("status", "createdAt");
