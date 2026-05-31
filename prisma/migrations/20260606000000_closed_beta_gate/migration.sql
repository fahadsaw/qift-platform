-- Closed Beta Gate.
--
-- Three additive tables backing the closed-beta registration gate.
-- Purely additive: no ALTER on existing tables, no backfill, fully
-- reversible (DROP TABLE on rollback). Existing accounts and the
-- existing gift `Invite` table are untouched.
--
-- These tables are consulted ONLY when the BETA_GATE_ENABLED env var
-- is true AND /auth/register hits the new-user branch. See the
-- schema.prisma doc-block for the full gate contract.
--
-- `createdBy` / `userId` are plain TEXT user-id columns (no foreign
-- key) on purpose: the gate is an operational audit side-table that
-- must survive a purge of the operator who minted a code, and we
-- avoid adding inbound relations to the already-large User table.

-- CreateTable
CREATE TABLE "BetaInviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetaInviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetaInviteRedemption" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetaInviteRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetaAllowlistEntry" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetaAllowlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BetaInviteCode_code_key" ON "BetaInviteCode"("code");

-- CreateIndex
CREATE INDEX "BetaInviteCode_disabledAt_idx" ON "BetaInviteCode"("disabledAt");

-- CreateIndex
CREATE INDEX "BetaInviteRedemption_codeId_idx" ON "BetaInviteRedemption"("codeId");

-- CreateIndex
CREATE UNIQUE INDEX "BetaInviteRedemption_codeId_userId_key" ON "BetaInviteRedemption"("codeId", "userId");

-- CreateIndex
CREATE INDEX "BetaAllowlistEntry_kind_value_idx" ON "BetaAllowlistEntry"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "BetaAllowlistEntry_kind_value_key" ON "BetaAllowlistEntry"("kind", "value");

-- AddForeignKey
ALTER TABLE "BetaInviteRedemption" ADD CONSTRAINT "BetaInviteRedemption_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "BetaInviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
