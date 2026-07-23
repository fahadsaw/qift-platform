-- Three-way Treasury Reconciliation (Lane 2 PR 1) — SC §10.3 / FC Ch. 17.2.
-- Additive only: two new append-only tables. No existing table touched.
-- Read-only over money: no ledger writes originate from this subsystem.

CREATE TABLE "TreasuryAttestation" (
    "id" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'safeguarding',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "balance" DECIMAL(14,2) NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual_attestation',
    "evidenceRef" TEXT NOT NULL,
    "notes" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryAttestation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TreasuryAttestation_accountType_asOfDate_idx" ON "TreasuryAttestation"("accountType", "asOfDate");

CREATE TABLE "TreasuryReconciliation" (
    "id" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'safeguarding',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "attestationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "bankBalance" DECIMAL(14,2),
    "ledgerCashBalance" DECIMAL(14,2) NOT NULL,
    "obligationsBalance" DECIMAL(14,2) NOT NULL,
    "bankVsCashDelta" DECIMAL(14,2),
    "cashVsObligationsDelta" DECIMAL(14,2) NOT NULL,
    "differenceCount" INTEGER NOT NULL,
    "canonicalJson" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "computedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "investigatedBy" TEXT,
    "investigatedAt" TIMESTAMP(3),
    "investigationNotes" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,
    "resolutionEvidenceRef" TEXT,

    CONSTRAINT "TreasuryReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TreasuryReconciliation_accountType_asOfDate_idx" ON "TreasuryReconciliation"("accountType", "asOfDate");
CREATE INDEX "TreasuryReconciliation_status_idx" ON "TreasuryReconciliation"("status");
