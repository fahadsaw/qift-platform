import { FINANCIAL_EVENTS, ledgerIdempotencyKey } from './financial-events';

describe('financial event taxonomy (FIN-4)', () => {
  it('carries the canonical vocabulary — live producers + reserved phases', () => {
    expect(FINANCIAL_EVENTS).toEqual({
      ORDER_PAID: 'order.paid',
      QIFT_SERVICE_FEE_ACCRUED: 'qift.service_fee.accrued',
      MERCHANT_PAYABLE_ACCRUED: 'merchant.payable.accrued',
      DELIVERY_FEE_ACCRUED: 'delivery.fee.accrued',
      CORPORATE_INVOICE_ISSUED: 'corporate.invoice.issued',
      MERCHANT_INVOICE_ISSUED: 'merchant.invoice.issued',
      // SETTLE-1 (Track C PR 2): FC Ch. 3.2 reserved events now live —
      // receipts anchor on receiptId; recognition anchors on invoiceId
      // under a RECORDED policy version (FC 7.6).
      INVOICE_PAYMENT_RECEIVED: 'invoice.payment.received',
      QIFT_REVENUE_RECOGNIZED: 'qift.revenue.recognized',
      // SETTLE-2 (Track C PR 3): the executed bank movement, anchored
      // on remittanceId (FC Ch. 3.2 reserved, now live).
      MERCHANT_REMITTANCE_PAID: 'merchant.remittance.paid',
      SETTLEMENT_STARTED: 'settlement.started',
      SETTLEMENT_COMPLETED: 'settlement.completed',
      // Track C PR 1 (SC v2.0 §11.1): the third lifecycle marker —
      // every started batch closes with completed OR superseded.
      SETTLEMENT_SUPERSEDED: 'settlement.superseded',
      REFUND_REQUESTED: 'refund.requested',
      REFUND_APPROVED: 'refund.approved',
      REFUND_PAID: 'refund.paid',
      CHARGEBACK_CREATED: 'chargeback.created',
    });
  });

  it('every event name follows domain.action dot-notation', () => {
    for (const value of Object.values(FINANCIAL_EVENTS)) {
      expect(value).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it('idempotency keys are deterministic and anchor-scoped', () => {
    const a = ledgerIdempotencyKey(FINANCIAL_EVENTS.ORDER_PAID, 'order-1');
    const b = ledgerIdempotencyKey(FINANCIAL_EVENTS.ORDER_PAID, 'order-1');
    expect(a).toBe(b); // same (event, anchor) → same key, always
    expect(a).toBe('order.paid:order-1');
    // Different anchors or events never collide.
    expect(
      ledgerIdempotencyKey(FINANCIAL_EVENTS.ORDER_PAID, 'order-2'),
    ).not.toBe(a);
    expect(
      ledgerIdempotencyKey(
        FINANCIAL_EVENTS.CORPORATE_INVOICE_ISSUED,
        'order-1',
      ),
    ).not.toBe(a);
  });
});
