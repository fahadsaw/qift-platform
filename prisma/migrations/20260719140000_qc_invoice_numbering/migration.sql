-- Track A.5 PR 4: Qift service-invoice sequential numbering (QC-YYYY-NNNNN)
-- + the transactional NumberSequence table. Agent model: this numbers
-- ONLY Qift's own service-fee invoice (CorporateInvoice); merchant
-- goods invoices are the merchant's to number (PR 5).
-- Production CorporateInvoice rows: ZERO (verified read-only 2026-07-19).

-- CreateTable
CREATE TABLE "NumberSequence" (
    "seriesKey" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("seriesKey")
);

-- AlterTable (additive, nullable first)
ALTER TABLE "CorporateInvoice" ADD COLUMN "invoiceNumber" TEXT;

-- Backfill: sequential per issue-year, ordered by creation time, and
-- the NumberSequence rows are seeded to match so live allocation
-- continues the series without collision.
DO $$
DECLARE
  r RECORD;
  y INT;
  v INT;
BEGIN
  FOR r IN
    SELECT "id", "createdAt" FROM "CorporateInvoice"
    WHERE "invoiceNumber" IS NULL
    ORDER BY "createdAt" ASC, "id" ASC
  LOOP
    y := EXTRACT(YEAR FROM r."createdAt" AT TIME ZONE 'UTC')::int;
    INSERT INTO "NumberSequence" ("seriesKey", "lastValue", "updatedAt")
      VALUES ('QC-' || y, 1, now())
      ON CONFLICT ("seriesKey")
      DO UPDATE SET "lastValue" = "NumberSequence"."lastValue" + 1,
                    "updatedAt" = now();
    SELECT "lastValue" INTO v FROM "NumberSequence" WHERE "seriesKey" = 'QC-' || y;
    UPDATE "CorporateInvoice"
      SET "invoiceNumber" = 'QC-' || y || '-' || lpad(v::text, 5, '0')
      WHERE "id" = r."id";
  END LOOP;
END $$;

-- Constrain
ALTER TABLE "CorporateInvoice" ALTER COLUMN "invoiceNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CorporateInvoice_invoiceNumber_key" ON "CorporateInvoice"("invoiceNumber");
