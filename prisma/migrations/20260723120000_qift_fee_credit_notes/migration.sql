-- SETTLE-3c-1 (Track C PR 9): Qift fee-leg credit notes — QD legal
-- series (RC v4.0), frozen legal fields, nullable store party (the
-- fee leg has none). ALTERs relax NOT NULL on OUR OWN empty tables
-- (prod verified 0 rows) — forward-safe. (FC Rule 13.8.)

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "buyerSnapshot" JSONB,
ADD COLUMN     "issuerSnapshot" JSONB,
ADD COLUMN     "netComponent" DECIMAL(12,2),
ADD COLUMN     "qiftCreditNoteNumber" TEXT,
ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "taxRuleVersion" TEXT,
ALTER COLUMN "storeId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SettlementRefund" ALTER COLUMN "storeId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_qiftCreditNoteNumber_key" ON "CreditNote"("qiftCreditNoteNumber");

