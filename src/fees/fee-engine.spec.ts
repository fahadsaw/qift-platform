import {
  computeFees,
  deliveryFeeFor,
  feePolicySnapshot,
  serviceFeeFor,
  FAST_DELIVERY_FEE,
  QIFT_MIN_SERVICE_FEE,
  QIFT_SERVICE_FEE_RATE,
  STANDARD_DELIVERY_FEE,
} from './fee-engine';

describe('FeeEngine', () => {
  describe('serviceFeeFor', () => {
    it('charges 3% of the item subtotal', () => {
      expect(serviceFeeFor(500)).toBe(15);
      expect(serviceFeeFor(1000)).toBe(30);
    });

    it('applies the SAR floor for small subtotals', () => {
      // 3% of 50 = 1.5 → below the floor → floored to 5.
      expect(serviceFeeFor(50)).toBe(QIFT_MIN_SERVICE_FEE);
      expect(serviceFeeFor(0)).toBe(QIFT_MIN_SERVICE_FEE);
    });

    it('rounds to the nearest whole SAR', () => {
      // 3% of 133 = 3.99 → rounds to 4, but floor lifts it to 5.
      expect(serviceFeeFor(133)).toBe(5);
      // 3% of 250 = 7.5 → rounds to 8.
      expect(serviceFeeFor(250)).toBe(8);
    });
  });

  describe('deliveryFeeFor', () => {
    it('is flat for fast, free for same-day', () => {
      expect(deliveryFeeFor('fast')).toBe(FAST_DELIVERY_FEE);
      expect(deliveryFeeFor('same_day')).toBe(STANDARD_DELIVERY_FEE);
    });
  });

  describe('computeFees', () => {
    it('mirrors the historical checkout arithmetic (same_day)', () => {
      // Historically: delivery = 0, service = max(5, round(500*0.03)) = 15,
      // total = 500 + 0 + 15 = 515.
      const f = computeFees({ itemSubtotal: 500, deliverySpeed: 'same_day' });
      expect(f).toMatchObject({
        itemSubtotal: 500,
        deliveryFee: 0,
        serviceFee: 15,
        grandTotal: 515,
      });
    });

    it('mirrors the historical checkout arithmetic (fast)', () => {
      // delivery = 15, service = round(1000*0.03) = 30, total = 1045.
      const f = computeFees({ itemSubtotal: 1000, deliverySpeed: 'fast' });
      expect(f).toMatchObject({
        itemSubtotal: 1000,
        deliveryFee: 15,
        serviceFee: 30,
        grandTotal: 1045,
      });
    });

    it('carries an immutable policy snapshot for future ledger/invoice use', () => {
      const f = computeFees({ itemSubtotal: 100, deliverySpeed: 'same_day' });
      expect(f.policy).toEqual(feePolicySnapshot());
      expect(f.policy.serviceFeeRate).toBe(QIFT_SERVICE_FEE_RATE);
      expect(f.policy.version).toBe('fee-v1');
    });
  });
});
