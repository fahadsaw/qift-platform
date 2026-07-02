import { computeInvoiceAmounts } from './invoice-amounts';
import { serviceFeeFor, FEE_POLICY_VERSION } from '../fees/fee-engine';

describe('computeInvoiceAmounts', () => {
  it('bills subtotal + platform fee for N identical gifts', () => {
    // unit 500, 10 recipients: subtotal 5000, fee serviceFeeFor(500)=15
    // per gift * 10 = 150, total 5150.
    const a = computeInvoiceAmounts(500, 10);
    expect(a).toMatchObject({
      unitAmount: 500,
      recipientCount: 10,
      subtotalAmount: 5000,
      platformFeeAmount: 150,
      totalAmount: 5150,
      feePolicyVersion: FEE_POLICY_VERSION,
    });
  });

  it('applies the FeeEngine per-unit fee (including its floor)', () => {
    // unit 50: serviceFeeFor(50) floors to 5; * 2 = 10; subtotal 100.
    const a = computeInvoiceAmounts(50, 2);
    expect(a.platformFeeAmount).toBe(serviceFeeFor(50) * 2);
    expect(a.platformFeeAmount).toBe(10);
    expect(a.totalAmount).toBe(110);
  });

  it('total always equals subtotal + platform fee', () => {
    for (const [unit, n] of [
      [100, 3],
      [250, 7],
      [1000, 1],
    ] as const) {
      const a = computeInvoiceAmounts(unit, n);
      expect(a.totalAmount).toBe(a.subtotalAmount + a.platformFeeAmount);
      expect(a.subtotalAmount).toBe(unit * n);
    }
  });
});
