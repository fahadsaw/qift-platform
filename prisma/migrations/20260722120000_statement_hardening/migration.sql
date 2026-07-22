-- STATEMENT HARDENING (Track C PR 4): canonical JSON as source of
-- truth, future digital signatures, versioned replay run log.
-- Additive; the NOT NULL canonicalJson lands on a structurally empty
-- table (statements cannot issue before the Ch. 17.4 gate attestation,
-- and this migration precedes any attestation). Forward-only (FC
-- Rule 13.8): rollback = revert code; tables/columns remain.

-- AlterTable
ALTER TABLE "SettlementStatementRecord" ADD COLUMN     "canonicalJson" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "SettlementStatementSignature" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "statementHash" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signedBy" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementStatementSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementReplayRecord" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "replayEngineVersion" TEXT NOT NULL,
    "calculationReplayVerified" BOOLEAN NOT NULL,
    "statementIntegrityVerified" BOOLEAN NOT NULL,
    "statementIdentical" BOOLEAN NOT NULL,
    "ranBy" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementReplayRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementStatementSignature_settlementId_idx" ON "SettlementStatementSignature"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementReplayRecord_settlementId_ranAt_idx" ON "SettlementReplayRecord"("settlementId", "ranAt");

