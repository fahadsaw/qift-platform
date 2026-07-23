-- Zero-Net Statement-Only Close (Lane 2 PR 2) — SC §26.
-- Additive only: two nullable lifecycle columns on SettlementBatch.
-- closureType: 'remitted' | 'zero_net_no_transfer', written once
-- atomically with the terminal transition. closedAt: the recording
-- instant of the close (day-aggregate basis for no-transfer closes).
ALTER TABLE "SettlementBatch" ADD COLUMN "closureType" TEXT;
ALTER TABLE "SettlementBatch" ADD COLUMN "closedAt" TIMESTAMP(3);
