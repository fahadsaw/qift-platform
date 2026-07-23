-- Financial Integrity Hardening (Lane 2 PR 3).
-- Additive DDL + database-level append-only protection (Scope B).
-- No existing column altered, no data touched, no DROP of any
-- table/column (the DROP TRIGGER IF EXISTS lines below are
-- idempotent re-create guards for replay safety, not removals).

-- Scope A: deterministic guaranteed-audit key.
ALTER TABLE "AuditLog" ADD COLUMN "auditKey" TEXT;
CREATE UNIQUE INDEX "AuditLog_auditKey_key" ON "AuditLog"("auditKey");

-- Scope D: structured resolution basis.
ALTER TABLE "TreasuryReconciliation" ADD COLUMN "resolutionKind" TEXT;
ALTER TABLE "TreasuryReconciliation" ADD COLUMN "resolutionMatchedRunId" TEXT;

-- Scope C: internal-transfer evidence (append-only).
CREATE TABLE "TreasuryInternalTransfer" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "confirmedAmount" DECIMAL(14,2) NOT NULL,
    "bankReference" TEXT NOT NULL,
    "valueDate" TIMESTAMP(3) NOT NULL,
    "accountFromMasked" TEXT NOT NULL,
    "accountToMasked" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "recordedBy" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TreasuryInternalTransfer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TreasuryInternalTransfer_bankReference_key" ON "TreasuryInternalTransfer"("bankReference");
CREATE INDEX "TreasuryInternalTransfer_settlementId_idx" ON "TreasuryInternalTransfer"("settlementId");
CREATE INDEX "TreasuryInternalTransfer_status_idx" ON "TreasuryInternalTransfer"("status");

-- ── Scope B: DATABASE-LEVEL APPEND-ONLY PROTECTION ──────────────────
-- Strongest practical layer on managed Postgres (the app connects as
-- the table owner, so REVOKE cannot bind it — BEFORE triggers can).
-- Constitutionally immutable tables reject UPDATE and DELETE at the
-- database itself; corrections remain compensating entries or new
-- document versions (SC §11/§24, FC Ch. 4/5).
CREATE OR REPLACE FUNCTION qift_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append_only_violation: % on % is constitutionally forbidden (SC §11/§24, FC Ch.4/5)',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- FinancialLedgerEntry — the ledger IS the event log; never edited.
DROP TRIGGER IF EXISTS qift_append_only_ledger ON "FinancialLedgerEntry";
CREATE TRIGGER qift_append_only_ledger
  BEFORE UPDATE OR DELETE ON "FinancialLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- AuditLog — create-only audit trail.
DROP TRIGGER IF EXISTS qift_append_only_audit ON "AuditLog";
CREATE TRIGGER qift_append_only_audit
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- CreditNoteVersion — immutable legal-document versions.
DROP TRIGGER IF EXISTS qift_append_only_credit_note_version ON "CreditNoteVersion";
CREATE TRIGGER qift_append_only_credit_note_version
  BEFORE UPDATE OR DELETE ON "CreditNoteVersion"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- SettlementStatementRecord — issued statements are immutable.
DROP TRIGGER IF EXISTS qift_append_only_statement ON "SettlementStatementRecord";
CREATE TRIGGER qift_append_only_statement
  BEFORE UPDATE OR DELETE ON "SettlementStatementRecord"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- SettlementStatementSignature — append-only envelopes.
DROP TRIGGER IF EXISTS qift_append_only_signature ON "SettlementStatementSignature";
CREATE TRIGGER qift_append_only_signature
  BEFORE UPDATE OR DELETE ON "SettlementStatementSignature"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- SettlementReplayRecord — append-only verification acts.
DROP TRIGGER IF EXISTS qift_append_only_replay ON "SettlementReplayRecord";
CREATE TRIGGER qift_append_only_replay
  BEFORE UPDATE OR DELETE ON "SettlementReplayRecord"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- SettlementRemittance — immutable bank-movement evidence.
DROP TRIGGER IF EXISTS qift_append_only_remittance ON "SettlementRemittance";
CREATE TRIGGER qift_append_only_remittance
  BEFORE UPDATE OR DELETE ON "SettlementRemittance"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- SettlementApproval — immutable votes (§31.5: recast = new row).
DROP TRIGGER IF EXISTS qift_append_only_approval ON "SettlementApproval";
CREATE TRIGGER qift_append_only_approval
  BEFORE UPDATE OR DELETE ON "SettlementApproval"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- SettlementExecutionPreview — immutable recorded acts.
DROP TRIGGER IF EXISTS qift_append_only_preview ON "SettlementExecutionPreview";
CREATE TRIGGER qift_append_only_preview
  BEFORE UPDATE OR DELETE ON "SettlementExecutionPreview"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- PaymentReceipt — immutable cash-in evidence.
DROP TRIGGER IF EXISTS qift_append_only_receipt ON "PaymentReceipt";
CREATE TRIGGER qift_append_only_receipt
  BEFORE UPDATE OR DELETE ON "PaymentReceipt"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- TreasuryAttestation — append-only bank evidence.
DROP TRIGGER IF EXISTS qift_append_only_attestation ON "TreasuryAttestation";
CREATE TRIGGER qift_append_only_attestation
  BEFORE UPDATE OR DELETE ON "TreasuryAttestation"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- TreasuryInternalTransfer — append-only transfer evidence.
DROP TRIGGER IF EXISTS qift_append_only_internal_transfer ON "TreasuryInternalTransfer";
CREATE TRIGGER qift_append_only_internal_transfer
  BEFORE UPDATE OR DELETE ON "TreasuryInternalTransfer"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- SettlementRefund — immutable cash-OUT evidence (review finding 1:
-- the cash-in twin was protected; the refund row's amounts feed every
-- downstream cap/effective-total/recognition sum).
DROP TRIGGER IF EXISTS qift_append_only_settlement_refund ON "SettlementRefund";
CREATE TRIGGER qift_append_only_settlement_refund
  BEFORE UPDATE OR DELETE ON "SettlementRefund"
  FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation();

-- Review finding 3: at most ONE completed internal transfer per
-- settlement, enforced by the DATABASE — a concurrent double-complete
-- with two different bank references loses loudly instead of
-- silently absorbing a double-sweep.
CREATE UNIQUE INDEX "TreasuryInternalTransfer_completed_settlement_key"
  ON "TreasuryInternalTransfer"("settlementId")
  WHERE "status" = 'completed';

-- STATEFUL BY CONSTITUTION (deliberately NOT protected — documented
-- in docs/APPEND_ONLY_PROTECTION.md): SettlementBatch, SettlementItem,
-- SettlementReceivable, TreasuryReconciliation, RefundRequest,
-- CreditNote (head row: version-pointer cache), CorporateInvoice,
-- MerchantInvoice, NumberSequence, PayoutEvent (legacy, frozen).
