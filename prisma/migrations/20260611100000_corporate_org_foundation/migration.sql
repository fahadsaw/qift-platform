-- Corporate Foundation PR 1 — Organization + OrgUser.
--
-- Purely additive: two new tables, no ALTER on existing tables, no
-- backfill, fully reversible (DROP TABLE "OrgUser"; DROP TABLE
-- "Organization"). Consumer tables untouched. createdBy/userId/
-- reviewedBy are plain TEXT (no FK to User) so org records survive
-- user purges — same posture as BetaInviteCode and AuditLog.

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "displayNameAr" TEXT,
    "crNumber" TEXT,
    "vatNumber" TEXT,
    "billingEmail" TEXT,
    "billingAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "riskTier" TEXT NOT NULL DEFAULT 'new',
    "rejectionReason" TEXT,
    "settings" JSONB,
    "createdBy" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgUser" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "invitedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUser_orgId_userId_key" ON "OrgUser"("orgId", "userId");

-- CreateIndex
CREATE INDEX "OrgUser_userId_idx" ON "OrgUser"("userId");

-- AddForeignKey
ALTER TABLE "OrgUser" ADD CONSTRAINT "OrgUser_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
