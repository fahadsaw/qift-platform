-- SETTLE-2 (Track C PR 3): approvals (per-round votes), preview-act
-- records, remittance, statements + SettlementBatch.assembledBy
-- (proposer, §31.1/§33.4). Additive only. Forward-only financial
-- schema (FC Rule 13.8): rollback = revert code; tables remain.

-- AlterTable
ALTER TABLE "SettlementBatch" ADD COLUMN     "assembledBy" TEXT;

-- CreateTable
CREATE TABLE "SettlementApproval" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "calculationHash" TEXT NOT NULL,
    "requiredLevel" INTEGER NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementExecutionPreview" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "calculationHash" TEXT NOT NULL,
    "replayVerified" BOOLEAN NOT NULL,
    "previewedBy" TEXT NOT NULL,
    "previewedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementExecutionPreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementRemittance" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "amount" DECIMAL(12,2) NOT NULL,
    "bankTransferReference" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL,
    "executedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementStatementRecord" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "statementVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statementHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementStatementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementApproval_settlementId_idx" ON "SettlementApproval"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementApproval_settlementId_approvedBy_approvedAt_key" ON "SettlementApproval"("settlementId", "approvedBy", "approvedAt");

-- CreateIndex
CREATE INDEX "SettlementExecutionPreview_settlementId_previewedAt_idx" ON "SettlementExecutionPreview"("settlementId", "previewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRemittance_settlementId_key" ON "SettlementRemittance"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementRemittance_storeId_executedAt_idx" ON "SettlementRemittance"("storeId", "executedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementStatementRecord_settlementId_key" ON "SettlementStatementRecord"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementStatementRecord_storeId_issuedAt_idx" ON "SettlementStatementRecord"("storeId", "issuedAt");

