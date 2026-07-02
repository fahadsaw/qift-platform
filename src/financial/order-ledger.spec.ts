import { FEE_POLICY_VERSION } from '../fees/fee-engine';
import { buildOrderLedgerEntries, LEDGER_REASON } from './order-ledger';

// A paid order carrying the server-authoritative FeeEngine amounts:
//   productPrice 500 + serviceFee 15 + deliveryFee 15 = totalAmount 530.
function paidOrder(overrides: Partial<Parameters<typeof buildOrderLedgerEntries>[0]> = {}) {
  return {
    id: 'order-1',
    userId: 'buyer-1',
    storeId: 'store-1',
    productPrice: 500,
    serviceFee: 15,
    deliveryFee: 15,
    totalAmount: 530,
    currency: 'SAR',
    paymentProvider: 'mada',
    ...overrides,
  };
}

const byReason = (entries: ReturnType<typeof buildOrderLedgerEntries>) =>
  Object.fromEntries(entries.map((e) => [e.reasonCode, e]));

describe('buildOrderLedgerEntries', () => {
  it('produces the four allocation entries with server-authoritative amounts', () => {
    const entries = buildOrderLedgerEntries(paidOrder(), 'pay-1');
    const r = byReason(entries);

    expect(r[LEDGER_REASON.ORDER_PAID]).toMatchObject({
      amount: 530,
      direction: 'credit',
      counterpartyType: 'sender',
      actorType: 'user',
      actorId: 'buyer-1',
    });
    expect(r[LEDGER_REASON.QIFT_SERVICE_FEE]).toMatchObject({
      amount: 15,
      direction: 'credit',
      counterpartyType: 'qift',
    });
    expect(r[LEDGER_REASON.MERCHANT_PAYABLE]).toMatchObject({
      amount: 500,
      direction: 'debit',
      counterpartyType: 'merchant',
      storeId: 'store-1',
    });
    expect(r[LEDGER_REASON.DELIVERY_FEE]).toMatchObject({
      amount: 15,
      direction: 'debit',
      counterpartyType: 'merchant',
    });
  });

  it('allocations sum back to the captured total (balanced)', () => {
    const entries = buildOrderLedgerEntries(paidOrder(), 'pay-1');
    const r = byReason(entries);
    const allocated =
      r[LEDGER_REASON.QIFT_SERVICE_FEE].amount +
      r[LEDGER_REASON.MERCHANT_PAYABLE].amount +
      r[LEDGER_REASON.DELIVERY_FEE].amount;
    expect(allocated).toBe(r[LEDGER_REASON.ORDER_PAID].amount);
  });

  it('every entry carries the order + payment ids and currency', () => {
    const entries = buildOrderLedgerEntries(paidOrder(), 'pay-1');
    for (const e of entries) {
      expect(e.orderId).toBe('order-1');
      expect(e.paymentId).toBe('pay-1');
      expect(e.currency).toBe('SAR');
    }
  });

  it('metadata is privacy-safe: only fee policy + provider, no recipient PII', () => {
    const entries = buildOrderLedgerEntries(paidOrder(), 'pay-1');
    for (const e of entries) {
      expect(e.metadata).toEqual({
        feePolicyVersion: FEE_POLICY_VERSION,
        paymentProvider: 'mada',
      });
      const flat = JSON.stringify(e).toLowerCase();
      for (const banned of ['address', 'phone', 'receiver', 'street', 'claim', 'message']) {
        expect(flat).not.toContain(banned);
      }
    }
  });

  it('omits the delivery entry when no delivery fee was charged', () => {
    const entries = buildOrderLedgerEntries(
      paidOrder({ deliveryFee: 0, totalAmount: 515 }),
      'pay-1',
    );
    expect(byReason(entries)[LEDGER_REASON.DELIVERY_FEE]).toBeUndefined();
    expect(entries).toHaveLength(3);
  });

  it('omits merchant payable when the order is not linked to a store', () => {
    const entries = buildOrderLedgerEntries(
      paidOrder({ storeId: null, deliveryFee: 0, totalAmount: 515 }),
      null,
    );
    const r = byReason(entries);
    expect(r[LEDGER_REASON.MERCHANT_PAYABLE]).toBeUndefined();
    expect(r[LEDGER_REASON.ORDER_PAID]).toBeDefined();
    expect(r[LEDGER_REASON.QIFT_SERVICE_FEE]).toBeDefined();
  });
});
