-- PR 3: FinancialLedgerEntry idempotency key.
--
-- PURELY ADDITIVE: one unique index. No table/column/row is touched.
-- Reversible with:
--   DROP INDEX "FinancialLedgerEntry_orderId_reasonCode_key";
--
-- One ledger entry per (orderId, reasonCode). A paid order posts each
-- reasonCode (ORDER_PAID, QIFT_SERVICE_FEE, MERCHANT_PAYABLE,
-- DELIVERY_FEE) at most once, so a retried payment confirmation cannot
-- create duplicate rows — the second insert raises a unique violation
-- (P2002) that the producer treats as "already posted".
--
-- PostgreSQL NULL-distinct semantics mean entries with orderId = NULL
-- (non-order postings) are NOT constrained by this index — matching the
-- Gift / DispatchJob idempotency-key pattern already in this schema.

-- CreateIndex
CREATE UNIQUE INDEX "FinancialLedgerEntry_orderId_reasonCode_key" ON "FinancialLedgerEntry"("orderId", "reasonCode");
