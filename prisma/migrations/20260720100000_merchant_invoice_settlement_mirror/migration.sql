-- Track B1 / PE-13: MerchantInvoice column mirror (SETTLE-1 prerequisite).
-- Implements: Financial Constitution Ch. 21 pre-authorized MODIFY
-- ("MerchantInvoice: KEEP; MODIFY: paidAt/dueDate/export columns").
-- Columns ONLY — no writers exist in this PR; paidAt stays NULL until
-- SETTLE-1's receipt-derived markPaid (Ch. 6.2). All additive+nullable
-- (defaulted where the CorporateInvoice mirror source is defaulted).
-- Production MerchantInvoice rows: ZERO (verified read-only 2026-07-20).
-- ROLLBACK: financial schema is forward-only (Core Invariants #22) —
-- rollback = revert application code; these unread columns remain.

ALTER TABLE "MerchantInvoice" ADD COLUMN "externalAccountingProvider" TEXT;
ALTER TABLE "MerchantInvoice" ADD COLUMN "externalAccountingInvoiceId" TEXT;
ALTER TABLE "MerchantInvoice" ADD COLUMN "accountingExportStatus" TEXT NOT NULL DEFAULT 'not_exported';
ALTER TABLE "MerchantInvoice" ADD COLUMN "accountingExportedAt" TIMESTAMP(3);
ALTER TABLE "MerchantInvoice" ADD COLUMN "accountingExportError" TEXT;
ALTER TABLE "MerchantInvoice" ADD COLUMN "dueDate" TIMESTAMP(3);
ALTER TABLE "MerchantInvoice" ADD COLUMN "paidAt" TIMESTAMP(3);
