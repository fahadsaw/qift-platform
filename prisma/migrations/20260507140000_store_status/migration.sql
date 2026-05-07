-- Approval lifecycle for stores. Backfills existing rows to
-- "approved" so the migration is non-destructive: every store
-- created before this column existed was already serving traffic,
-- so flipping them all to "pending" would have killed the merchant
-- fulfilment queue overnight. The schema-level default for *new*
-- stores is "pending" — see prisma/schema.prisma.
ALTER TABLE "Store" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
UPDATE "Store" SET "status" = 'approved' WHERE "status" = 'pending';
