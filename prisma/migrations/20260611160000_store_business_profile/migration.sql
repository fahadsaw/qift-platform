-- B1: StoreBusinessProfile — Qift Business eligibility.
--
-- PURELY ADDITIVE: one new table + indexes + one FK to "Store"
-- (CASCADE). No existing table, column, or row is touched.
-- Reversible with:
--   DROP TABLE "StoreBusinessProfile";
--
-- Structural notes:
--   * "storeId" UNIQUE — one business profile per store; no row
--     means the store never applied.
--   * Consumer approval and business approval are INDEPENDENT:
--     nothing here reads or writes "Store"."status".
--   * "appliedBy"/"reviewedBy" are plain TEXT (purge-survivable).

-- CreateTable
CREATE TABLE "StoreBusinessProfile" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "appliedBy" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreBusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreBusinessProfile_storeId_key" ON "StoreBusinessProfile"("storeId");

-- CreateIndex
CREATE INDEX "StoreBusinessProfile_status_idx" ON "StoreBusinessProfile"("status");

-- AddForeignKey
ALTER TABLE "StoreBusinessProfile" ADD CONSTRAINT "StoreBusinessProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
