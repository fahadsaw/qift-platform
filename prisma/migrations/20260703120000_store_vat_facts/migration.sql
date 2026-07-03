-- FIN-1: Store VAT facts (agent model).
--
-- PURELY ADDITIVE: three defaulted columns on Store. No existing
-- column, index, or row is touched. Reversible by dropping the columns.
--
-- The merchant is the legal seller of the goods, so the goods VAT on
-- every MerchantInvoice is governed by these per-merchant facts,
-- frozen into the invoice's taxSnapshot at issuance:
--   * "vatRegistered" DEFAULT false — VAT is charged on the goods ONLY
--     when true (KSA mandatory registration threshold SAR 375k; an
--     unregistered merchant must not charge VAT). The false default is
--     the safety posture: no merchant is ever VAT-charged by accident;
--     ops flips the flag after verifying registration (Store.vatNumber
--     should be recorded when true).
--   * "pricesIncludeVat" DEFAULT true — catalog-price convention (KSA
--     retail norm: displayed prices are VAT-inclusive). true = VAT is
--     extracted from the entered price; false = VAT added on top.
--     Only meaningful when vatRegistered.
--   * "taxCountry" DEFAULT 'SA' — ISO-3166 alpha-2 tax jurisdiction,
--     distinct from countryOfRegistration (a business-docs concern).
--
-- Existing rows inherit the defaults (vatRegistered=false), which is
-- the correct conservative state until ops records each merchant's
-- verified facts.

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "vatRegistered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Store" ADD COLUMN "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Store" ADD COLUMN "taxCountry" TEXT NOT NULL DEFAULT 'SA';
