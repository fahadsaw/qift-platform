-- FIN-2: invoice party snapshots (agent model).
--
-- PURELY ADDITIVE: four nullable JSONB columns — buyer + seller on each
-- invoice table. No existing column, index, or row is touched; every
-- pre-FIN-2 invoice keeps NULL (i.e. "no party snapshot recorded").
-- Reversible by dropping the columns.
--
-- WHY: both invoice tables are deliberately FK-free (plain-TEXT orgId /
-- storeId) so they survive org/store purges for regulatory retention —
-- which means a surviving invoice must carry its parties' LEGAL
-- IDENTITY itself. These columns freeze buyer + seller at issuance:
--   * CorporateInvoice (Qift SERVICE invoice): buyer = the company
--     (Organization legalName/CR/VAT), seller = QIFT (legal identity
--     from QIFT_LEGAL_NAME / QIFT_CR_NUMBER / QIFT_VAT_NUMBER env
--     config; the snapshot records configured=false until legal
--     onboarding sets them).
--   * MerchantInvoice (goods invoice): buyer = the company, seller =
--     the MERCHANT (Store legalEntityName/CR/VAT/taxCountry — the
--     legal seller of the goods).
-- Old invoices are never re-hydrated from live rows; renderers read
-- the frozen snapshot only. Business identity only — never employee
-- PII.

-- AlterTable
ALTER TABLE "CorporateInvoice" ADD COLUMN "buyerSnapshot" JSONB;
ALTER TABLE "CorporateInvoice" ADD COLUMN "sellerSnapshot" JSONB;

-- AlterTable
ALTER TABLE "MerchantInvoice" ADD COLUMN "buyerSnapshot" JSONB;
ALTER TABLE "MerchantInvoice" ADD COLUMN "sellerSnapshot" JSONB;
