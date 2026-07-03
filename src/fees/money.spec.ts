import {
  addMoney,
  fromMinor,
  minorDigitsFor,
  moneyToNumber,
  mulMoney,
  roundMoney,
  toMinor,
} from './money';

describe('Money (FIN-3 — the Shared Financial Core money policy)', () => {
  describe('exact decimal math — no floating rounding surprises', () => {
    it('0.1 + 0.2 is exactly 0.3', () => {
      expect(0.1 + 0.2).not.toBe(0.3); // the raw-float trap this fixes
      expect(addMoney([0.1, 0.2])).toBe(0.3);
    });

    it('unit-price × count is exact where raw floats drift', () => {
      expect(1.1 * 3).not.toBe(3.3); // raw float: 3.3000000000000003
      expect(mulMoney(1.1, 3)).toBe(3.3);
      expect(mulMoney(19.99, 3)).toBe(59.97);
      expect(mulMoney(0.07, 100)).toBe(7); // raw: 7.000000000000001
    });

    it('long addition chains stay exact', () => {
      // 100 × 0.01 — raw float accumulates drift; minor units do not.
      const cents = Array.from({ length: 100 }, () => 0.01);
      expect(addMoney(cents)).toBe(1);
    });

    it('the canonical invoice sum is exact', () => {
      // goods 5750 + Qift service 172.5 = 5922.5 (the two-invoice split)
      expect(addMoney([5750, 172.5])).toBe(5922.5);
    });

    it('mulMoney requires an integer count', () => {
      expect(() => mulMoney(10, 2.5)).toThrow(/integer/);
    });

    it('toMinor rejects non-finite input', () => {
      expect(() => toMinor(NaN)).toThrow(/non-finite/);
      expect(() => toMinor(Infinity)).toThrow(/non-finite/);
    });
  });

  describe('SAR 2-decimal rounding (the default policy)', () => {
    it('rounds to halalas, half-up', () => {
      expect(roundMoney(172.5)).toBe(172.5);
      expect(roundMoney(4347.826086956522)).toBe(4347.83); // VAT extraction
      expect(roundMoney(652.1739130434783)).toBe(652.17);
      expect(roundMoney(1.005000001)).toBe(1.01);
    });

    it('toMinor/fromMinor round-trip: SAR → halalas → SAR', () => {
      expect(toMinor(59.97)).toBe(5997);
      expect(fromMinor(5997)).toBe(59.97);
      expect(toMinor(0.01)).toBe(1);
    });

    it('absorbs accumulated float drift below half a halala', () => {
      // 19.99 * 3 in raw floats is 59.96999999999999…
      expect(toMinor(19.99 * 3)).toBe(5997);
    });
  });

  describe('future 3-decimal GCC currencies (registry readiness)', () => {
    it('knows the minor digits per currency', () => {
      expect(minorDigitsFor('SAR')).toBe(2);
      expect(minorDigitsFor('BHD')).toBe(3);
      expect(minorDigitsFor('KWD')).toBe(3);
      expect(minorDigitsFor('OMR')).toBe(3);
    });

    it('rounds and sums at 3 decimals for BHD (fils)', () => {
      expect(roundMoney(1.2345, 'BHD')).toBe(1.235); // hits fils, not cents
      expect(toMinor(1.235, 'BHD')).toBe(1235);
      expect(addMoney([0.001, 0.002], 'BHD')).toBe(0.003);
      expect(mulMoney(0.999, 3, 'BHD')).toBe(2.997);
    });
  });

  describe('moneyToNumber (Decimal → number boundary)', () => {
    it('passes numbers through and converts Decimal-like objects', () => {
      expect(moneyToNumber(172.5)).toBe(172.5);
      expect(moneyToNumber({ toNumber: () => 5750 })).toBe(5750);
      expect(moneyToNumber('59.97')).toBe(59.97);
      expect(moneyToNumber(null)).toBe(0);
      expect(moneyToNumber(undefined)).toBe(0);
    });
  });
});
