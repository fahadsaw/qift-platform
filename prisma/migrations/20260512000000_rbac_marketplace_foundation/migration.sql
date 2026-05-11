-- Marketplace + RBAC + finance ops foundation.
--
-- All additive. Existing rows + queries unchanged.

-- ── Marketplace ─────────────────────────────────────────────
-- Featured surfacing flag on Store. Admin-toggled via
-- PATCH /admin/stores/:id/featured. Drives the "Featured" rail
-- on /stores.
ALTER TABLE "Store" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;

-- ── RBAC: granular ops roles ───────────────────────────────
-- Layered on top of User.role (which stays the coarse
-- user/store/admin discriminator). Each row grants one ops
-- role to one user; the capability map in
-- apps/api/src/ops-roles/ops-roles.ts resolves a role into
-- concrete permissions.
CREATE TABLE "OpsRoleAssignment" (
  "id"        TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "role"      TEXT         NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "grantedBy" TEXT,

  CONSTRAINT "OpsRoleAssignment_pkey"       PRIMARY KEY ("id"),
  CONSTRAINT "OpsRoleAssignment_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OpsRoleAssignment_userId_role_key"
  ON "OpsRoleAssignment"("userId", "role");
CREATE INDEX "OpsRoleAssignment_role_idx" ON "OpsRoleAssignment"("role");

-- ── Finance ops ledger foundation ───────────────────────────
-- Append-only event log. No endpoints write to this table yet;
-- the schema lands so future settlement work has a stable
-- substrate.
CREATE TABLE "PayoutEvent" (
  "id"         TEXT         NOT NULL,
  "storeId"    TEXT         NOT NULL,
  "giftId"     TEXT,
  "type"       TEXT         NOT NULL,
  "amount"     DOUBLE PRECISION NOT NULL,
  "currency"   TEXT         NOT NULL,
  "reason"     TEXT,
  "recordedBy" TEXT         NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayoutEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayoutEvent_storeId_occurredAt_idx"
  ON "PayoutEvent"("storeId", "occurredAt");
CREATE INDEX "PayoutEvent_giftId_idx" ON "PayoutEvent"("giftId");
