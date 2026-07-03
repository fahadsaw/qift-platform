-- FIN-4: explicit ledger idempotency key.
--
-- PURELY ADDITIVE: one nullable TEXT column + one unique index on
-- FinancialLedgerEntry. No existing column, index, or row is touched
-- (the table holds zero rows in production as of FIN-3's verification);
-- pre-FIN-4 rows would simply keep NULL, which the unique index never
-- constrains (PostgreSQL NULL-distinct semantics). Reversible by
-- dropping the index + column.
--
-- WHY: the existing @@unique([orderId, reasonCode]) anchor cannot
-- protect campaign-scoped invoice postings (orderId = NULL) and cannot
-- express repeated same-reason legs in future phases (e.g. two partial
-- refunds). The explicit key is deterministic —
-- `${eventType}:${anchorId}` per src/financial/financial-events.ts —
-- so any retry / repair / backfill of the same posting collides with
-- the original row instead of duplicating it. The (orderId, reasonCode)
-- constraint is KEPT as belt-and-braces.

-- AlterTable
ALTER TABLE "FinancialLedgerEntry" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FinancialLedgerEntry_idempotencyKey_key" ON "FinancialLedgerEntry"("idempotencyKey");
