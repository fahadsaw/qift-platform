-- FIN-3: exact NUMERIC money on the financial-record tables.
--
-- Converts the settlement/PSP-reconciliation spine — FinancialLedgerEntry,
-- CorporateInvoice, MerchantInvoice — from DOUBLE PRECISION (binary
-- float) to exact NUMERIC(12,2) money columns (NUMERIC(5,4) for VAT
-- rates). Executed now, while these tables hold approximately zero
-- production rows, so the cast is trivial; after PSP integration it
-- would be surgery.
--
-- IN-PLACE TYPE CHANGE, NOT ADDITIVE — safety analysis:
--   * Every USING clause rounds to the target scale, and every existing
--     value was engine-rounded to <= 2 dp (rates are exact 0.15 / 0), so
--     the cast is LOSSLESS on real data: round(col::numeric, 2) recovers
--     the intended decimal value from any float representation.
--   * Nullability and NOT NULL constraints are preserved by ALTER TYPE.
--   * Reversible: ALTER back with USING "col"::double precision.
--
-- Order / Payment / PayoutEvent money columns were REVIEWED and their
-- conversion STAGED to the PSP phase (documented in schema.prisma) —
-- they have live consumer/frontend surfaces and PSP rebuilds them; the
-- authoritative financial records are the tables converted here.
--
-- The API wire format is unchanged: Prisma returns Decimal objects for
-- NUMERIC columns, and the global DecimalToNumberInterceptor converts
-- them back to plain JSON numbers in every response.

-- AlterTable — FinancialLedgerEntry
ALTER TABLE "FinancialLedgerEntry"
  ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING round("amount"::numeric, 2);

-- AlterTable — CorporateInvoice
ALTER TABLE "CorporateInvoice"
  ALTER COLUMN "unitAmount" TYPE DECIMAL(12,2) USING round("unitAmount"::numeric, 2),
  ALTER COLUMN "subtotalAmount" TYPE DECIMAL(12,2) USING round("subtotalAmount"::numeric, 2),
  ALTER COLUMN "platformFeeAmount" TYPE DECIMAL(12,2) USING round("platformFeeAmount"::numeric, 2),
  ALTER COLUMN "taxableAmount" TYPE DECIMAL(12,2) USING round("taxableAmount"::numeric, 2),
  ALTER COLUMN "vatRate" TYPE DECIMAL(5,4) USING round("vatRate"::numeric, 4),
  ALTER COLUMN "vatAmount" TYPE DECIMAL(12,2) USING round("vatAmount"::numeric, 2),
  ALTER COLUMN "totalBeforeVat" TYPE DECIMAL(12,2) USING round("totalBeforeVat"::numeric, 2),
  ALTER COLUMN "totalAmount" TYPE DECIMAL(12,2) USING round("totalAmount"::numeric, 2);

-- AlterTable — MerchantInvoice
ALTER TABLE "MerchantInvoice"
  ALTER COLUMN "unitAmount" TYPE DECIMAL(12,2) USING round("unitAmount"::numeric, 2),
  ALTER COLUMN "goodsSubtotalAmount" TYPE DECIMAL(12,2) USING round("goodsSubtotalAmount"::numeric, 2),
  ALTER COLUMN "vatRate" TYPE DECIMAL(5,4) USING round("vatRate"::numeric, 4),
  ALTER COLUMN "vatAmount" TYPE DECIMAL(12,2) USING round("vatAmount"::numeric, 2),
  ALTER COLUMN "totalAmount" TYPE DECIMAL(12,2) USING round("totalAmount"::numeric, 2);
