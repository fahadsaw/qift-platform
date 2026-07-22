-- SETTLE-3b (Track C PR 7): §7.4 recovery — frozen per-receivable
-- allocation on the batch + staging binding on the receivable.
-- Additive, forward-only (FC Rule 13.8).

-- AlterTable
ALTER TABLE "SettlementBatch" ADD COLUMN     "recoveryAllocation" JSONB;

-- AlterTable
ALTER TABLE "SettlementReceivable" ADD COLUMN     "stagedBySettlementId" TEXT;

