-- Merchant platform foundation: tiered plan column on Store.
--
-- Stable string union (`starter` | `pro` | `enterprise`) so adding
-- tiers doesn't need a Prisma enum migration. All existing rows
-- default to `starter`. The capability map in
-- apps/api/src/stores/merchant-plans.ts is the only thing that
-- should consume this field.
--
-- No billing infra is implied by this column — plan changes are
-- admin-assigned via PATCH /admin/stores/:id/plan today.

ALTER TABLE "Store"
  ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'starter';
