-- PR: CorporateInvoice tax snapshot + accounting-integration readiness.
--
-- PURELY ADDITIVE: 11 new nullable / defaulted columns on an existing
-- table. No existing column, index, or row is touched; existing rows
-- keep NULL for the tax columns (i.e. "no tax snapshot recorded") so
-- historical invoice correctness is preserved. Reversible by dropping
-- the columns.
--
-- Nullable tax columns = historical correctness: any pre-tax invoice is
-- left exactly as issued. New invoices freeze the full Saudi VAT v1
-- snapshot (src/fees/tax-engine.ts). accountingExportStatus defaults to
-- 'not_exported' — no third-party accounting integration exists yet.

-- AlterTable — tax snapshot
ALTER TABLE "CorporateInvoice" ADD COLUMN "taxableAmount" DOUBLE PRECISION;
ALTER TABLE "CorporateInvoice" ADD COLUMN "vatRate" DOUBLE PRECISION;
ALTER TABLE "CorporateInvoice" ADD COLUMN "vatAmount" DOUBLE PRECISION;
ALTER TABLE "CorporateInvoice" ADD COLUMN "totalBeforeVat" DOUBLE PRECISION;
ALTER TABLE "CorporateInvoice" ADD COLUMN "pricesIncludeVat" BOOLEAN;
ALTER TABLE "CorporateInvoice" ADD COLUMN "taxTreatment" TEXT;
ALTER TABLE "CorporateInvoice" ADD COLUMN "taxSnapshot" JSONB;

-- AlterTable — accounting integration readiness
ALTER TABLE "CorporateInvoice" ADD COLUMN "externalAccountingProvider" TEXT;
ALTER TABLE "CorporateInvoice" ADD COLUMN "externalAccountingInvoiceId" TEXT;
ALTER TABLE "CorporateInvoice" ADD COLUMN "accountingExportStatus" TEXT NOT NULL DEFAULT 'not_exported';
ALTER TABLE "CorporateInvoice" ADD COLUMN "accountingExportedAt" TIMESTAMP(3);
ALTER TABLE "CorporateInvoice" ADD COLUMN "accountingExportError" TEXT;
