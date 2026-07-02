-- PR 2: FinancialLedgerEntry — append-only financial ledger substrate.
--
-- PURELY ADDITIVE + DARK-LAUNCHED: one new table + indexes. No existing
-- table, column, or row is touched, and nothing writes to this table yet
-- (no producer is wired in this PR). Reversible with:
--   DROP TABLE "FinancialLedgerEntry";
--
-- Structural notes:
--   * NO foreign keys. Every correlation id ("orderId", "paymentId",
--     "storeId", "orgId", "campaignId", "actorId") is plain TEXT so the
--     financial trail survives the purge of any actor/entity it
--     references — same philosophy as "AuditLog" / "DispatchJob".
--   * "amount" is DOUBLE PRECISION (Prisma Float) to match the existing
--     "Order"/"Payment" money columns; positive magnitude, with
--     "direction" carrying the debit/credit sense.
--   * Append-only: this migration creates no UPDATE/DELETE affordance and
--     FinancialLedgerService exposes no update/delete path.

-- CreateTable
CREATE TABLE "FinancialLedgerEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "counterpartyType" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "campaignId" TEXT,
    "orgId" TEXT,
    "storeId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_orderId_idx" ON "FinancialLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_paymentId_idx" ON "FinancialLedgerEntry"("paymentId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_campaignId_idx" ON "FinancialLedgerEntry"("campaignId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_orgId_idx" ON "FinancialLedgerEntry"("orgId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_storeId_idx" ON "FinancialLedgerEntry"("storeId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_reasonCode_createdAt_idx" ON "FinancialLedgerEntry"("reasonCode", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_eventType_createdAt_idx" ON "FinancialLedgerEntry"("eventType", "createdAt");
