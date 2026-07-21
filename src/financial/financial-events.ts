// Financial event taxonomy (FIN-4) — the canonical vocabulary of the
// financial platform.
//
// The Foundation Freeze adopted "events as canonical semantics": every
// money mutation posts a ledger entry whose `eventType` names WHAT
// HAPPENED, drawn from THIS list — never an ad-hoc string. Invoices
// remain the canonical LEGAL documents; these events are the canonical
// triggers and audit trail. The ledger (FinancialLedgerEntry) IS the
// event log — no separate bus exists or is needed at this scale.
//
// Naming: `domain.action[.qualifier]`, lowercase, dot-separated.
// Add new events HERE first; a producer using a string literal that is
// not in this taxonomy is a review error.

export const FINANCIAL_EVENTS = {
  // ── Consumer order lifecycle (live producers) ────────────────────
  ORDER_PAID: 'order.paid',
  QIFT_SERVICE_FEE_ACCRUED: 'qift.service_fee.accrued',
  MERCHANT_PAYABLE_ACCRUED: 'merchant.payable.accrued',
  DELIVERY_FEE_ACCRUED: 'delivery.fee.accrued',

  // ── Corporate invoicing (live producers) ─────────────────────────
  CORPORATE_INVOICE_ISSUED: 'corporate.invoice.issued',
  MERCHANT_INVOICE_ISSUED: 'merchant.invoice.issued',

  // ── Payment receipts (SETTLE-1 — FC Ch. 3.2 reserved, now live) ──
  // Anchored on receiptId (partial payments on credit terms never
  // collide — FC Ch. 3.2). Cash-in against a document; the invoice's
  // `paid` status DERIVES from receipts covering the total.
  INVOICE_PAYMENT_RECEIVED: 'invoice.payment.received',
  // Fee-leg revenue recognition per the recognition clock (FC 7.6):
  // an advisor-set, VERSIONED policy choice recorded in metadata —
  // anchored on the invoiceId (recognized once per invoice).
  QIFT_REVENUE_RECOGNIZED: 'qift.revenue.recognized',

  // ── Settlement lifecycle (Track C — the engine produces these) ───
  // Zero-amount MARKER events (SC v2.0 §11.1): they close/open batch
  // dispositions on the single write path with deterministic keys and
  // move no money. Every settlement.started is closed by exactly ONE
  // of completed | superseded (SC §2 state law).
  SETTLEMENT_STARTED: 'settlement.started',
  SETTLEMENT_COMPLETED: 'settlement.completed',
  SETTLEMENT_SUPERSEDED: 'settlement.superseded',

  // ── Refunds / disputes (reserved — refunds phase) ────────────────
  REFUND_REQUESTED: 'refund.requested',
  REFUND_APPROVED: 'refund.approved',
  REFUND_PAID: 'refund.paid',
  CHARGEBACK_CREATED: 'chargeback.created',
} as const;

export type FinancialEventType =
  (typeof FINANCIAL_EVENTS)[keyof typeof FINANCIAL_EVENTS];

// Deterministic ledger idempotency key: the same (event, anchor) pair
// ALWAYS produces the same key, so any retry / repair / backfill of the
// same posting collides with the original row instead of duplicating
// it. The anchor is the id of the thing the event is about — orderId
// for order-lifecycle events, invoiceId for invoice events, and (later)
// settlementId / refundId for their phases.
export function ledgerIdempotencyKey(
  eventType: FinancialEventType,
  anchorId: string,
): string {
  return `${eventType}:${anchorId}`;
}
