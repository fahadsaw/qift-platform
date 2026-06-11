-- Corporate Foundation PR 2: CorporateContact roster table.
--
-- PURELY ADDITIVE: one new table + indexes + one FK to
-- "Organization" (CASCADE on org delete). No existing table, column,
-- or row is touched. Reversible with:
--   DROP TABLE "CorporateContact";
--
-- Structural notes (Corporate Core v2 §3):
--   * NO foreign key to "User" — employment data and consumer
--     identity must never join.
--   * NO address columns — recipient addresses are collected at
--     claim time, never supplied by the company.
--   * "purgeAfter" is NOT NULL: every roster row has a retention
--     deadline from the moment it exists.

-- CreateTable
CREATE TABLE "CorporateContact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "department" TEXT,
    "employeeRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "importBatchId" TEXT,
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorporateContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CorporateContact_orgId_status_idx" ON "CorporateContact"("orgId", "status");

-- CreateIndex
CREATE INDEX "CorporateContact_orgId_email_idx" ON "CorporateContact"("orgId", "email");

-- CreateIndex
CREATE INDEX "CorporateContact_orgId_phone_idx" ON "CorporateContact"("orgId", "phone");

-- CreateIndex
CREATE INDEX "CorporateContact_purgeAfter_idx" ON "CorporateContact"("purgeAfter");

-- AddForeignKey
ALTER TABLE "CorporateContact" ADD CONSTRAINT "CorporateContact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
