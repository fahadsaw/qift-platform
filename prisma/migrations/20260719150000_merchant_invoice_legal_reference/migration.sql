-- Track A.5 PR 5: merchant goods-invoice legal-reference architecture.
-- AGENT MODEL: the merchant is the legal seller; Qift NEVER
-- manufactures a merchant's legal invoice number. These columns hold
-- the merchant-supplied (or connector-supplied, or contractually
-- authorized on-behalf) reference. Purely additive; nullable; source
-- defaults to MERCHANT. Production MerchantInvoice rows: ZERO
-- (verified read-only 2026-07-19). Rollback = drop the four columns.

ALTER TABLE "MerchantInvoice" ADD COLUMN "merchantInvoiceNumber" TEXT;
ALTER TABLE "MerchantInvoice" ADD COLUMN "merchantInvoiceExternalId" TEXT;
ALTER TABLE "MerchantInvoice" ADD COLUMN "merchantInvoiceUrl" TEXT;
ALTER TABLE "MerchantInvoice" ADD COLUMN "invoiceNumberSource" TEXT NOT NULL DEFAULT 'MERCHANT';
ALTER TABLE "MerchantInvoice" ADD COLUMN "onBehalfAuthorizationRef" TEXT;
