-- Week 2 — Idempotency on POST /gifts.
--
-- Adds two NULL-tolerant columns to "Gift" plus a compound unique
-- index on (senderId, idempotencyKey). Re-submitted POST /gifts
-- requests carrying the same Idempotency-Key header from the same
-- sender resolve to the original gift instead of creating a
-- duplicate. Requests without the header behave exactly as before
-- (both columns NULL; the unique constraint permits multiple NULLs).
--
-- Operations:
--   ALTER TABLE ADD COLUMN ... — metadata-only on PostgreSQL when
--     no default + nullable. Instant on any size of Gift table.
--   CREATE UNIQUE INDEX        — small initially (all existing rows
--     have NULL); builds online without table rewrite.
--
-- Backfill: none required. All existing rows get NULL for both
-- columns automatically.
--
-- Rollback: see README in the PR description — `git revert` of
-- the application code is safe even with the columns still in the
-- DB (they sit unused). A schema-side rollback `ALTER TABLE DROP
-- COLUMN` is also safe and reversible.

-- AlterTable
ALTER TABLE "Gift" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Gift" ADD COLUMN "idempotencyRequestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Gift_senderId_idempotencyKey_key" ON "Gift"("senderId", "idempotencyKey");
