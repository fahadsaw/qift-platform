-- Track C PR 1: Settlement Engine Foundation.
-- Implements: Settlement Constitution v2.0 §2 (lifecycle), §14 (QS),
-- §34 (replay — frozen composition/calculation snapshots live on the
-- batch row). Financial-record table discipline (FC Rule 13.8): plain
-- TEXT ids, no FKs, no PII, exact NUMERIC money.
-- Additive only. Production rows created by this migration: ZERO (new
-- tables). FinancialLedgerEntry prod rows at migration time: 0
-- (verified read-only 2026-07-20).
-- ROLLBACK: forward-only financial schema (Core Invariants #22) —
-- revert application code; empty tables remain.

-- CreateTable
CREATE TABLE "SettlementBatch" (
    "id" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "windowType" TEXT NOT NULL DEFAULT 'manual',
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "composition" JSONB NOT NULL,
    "calculationSnapshot" JSONB NOT NULL,
    "supersededById" TEXT,
    "failureEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementItem" (
    "id" TEXT NOT NULL,
    "occurrenceType" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "amount" DECIMAL(12,2) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "batchId" TEXT,
    "holdType" TEXT,
    "holdEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SettlementBatch_settlementReference_key" ON "SettlementBatch"("settlementReference");
CREATE INDEX "SettlementBatch_storeId_status_idx" ON "SettlementBatch"("storeId", "status");
CREATE UNIQUE INDEX "SettlementItem_occurrenceType_occurrenceId_key" ON "SettlementItem"("occurrenceType", "occurrenceId");
CREATE INDEX "SettlementItem_storeId_state_idx" ON "SettlementItem"("storeId", "state");
CREATE INDEX "SettlementItem_batchId_idx" ON "SettlementItem"("batchId");
