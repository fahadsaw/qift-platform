import {
  computeTax,
  SAUDI_VAT_RATE,
  TAX_RULE_VERSION,
} from './tax-engine';

describe('TaxEngine (Saudi VAT v1)', () => {
  describe('default: full_value_standard, VAT-exclusive', () => {
    it('adds 15% VAT on the full (subtotal + fee) base', () => {
      // subtotal 5000 + fee 150 = 5150 taxable; VAT 772.5; total 5922.5
      const t = computeTax({ subtotalAmount: 5000, platformFeeAmount: 150 });
      expect(t).toMatchObject({
        taxTreatment: 'full_value_standard',
        pricesIncludeVat: false,
        taxableAmount: 5150,
        vatRate: 0.15,
        vatAmount: 772.5,
        totalBeforeVat: 5150,
        totalAmount: 5922.5,
      });
    });

    it('total always equals totalBeforeVat + vatAmount', () => {
      const t = computeTax({ subtotalAmount: 1234, platformFeeAmount: 40 });
      expect(t.totalAmount).toBe(t.totalBeforeVat + t.vatAmount);
      expect(t.vatAmount).toBe(Math.round(t.taxableAmount * 0.15 * 100) / 100);
    });

    it('uses the SERVER-SIDE rate — no client input required', () => {
      const t = computeTax({ subtotalAmount: 100, platformFeeAmount: 5 });
      expect(t.vatRate).toBe(SAUDI_VAT_RATE); // 0.15, from the engine
      expect(t.vatAmount).toBe(15.75); // round2(105 * 0.15)
    });
  });

  describe('agent_fee_only treatment (VAT on the Qift fee only)', () => {
    it('taxes only the platform fee', () => {
      const t = computeTax({
        subtotalAmount: 5000,
        platformFeeAmount: 150,
        treatment: 'agent_fee_only',
      });
      expect(t.taxableAmount).toBe(150);
      expect(t.vatAmount).toBe(22.5); // 150 * 0.15
      expect(t.totalBeforeVat).toBe(5150);
      expect(t.totalAmount).toBe(5172.5); // 5150 + 22.5
    });
  });

  describe('VAT-inclusive prices (extraction)', () => {
    it('extracts the VAT from a gross base and keeps total = totalBeforeVat + vat', () => {
      const t = computeTax({
        subtotalAmount: 5000,
        platformFeeAmount: 150,
        pricesIncludeVat: true,
      });
      // gross 5150 already includes VAT: net 4478.26, VAT 671.74
      expect(t.taxableAmount).toBe(4478.26);
      expect(t.vatAmount).toBe(671.74);
      expect(t.totalAmount).toBe(5150); // gross unchanged
      expect(t.totalAmount).toBe(
        Math.round((t.totalBeforeVat + t.vatAmount) * 100) / 100,
      );
    });
  });

  describe('taxSnapshot (frozen for historical correctness)', () => {
    it('records the rule version, rate, treatment and a provisional note', () => {
      const t = computeTax({ subtotalAmount: 100, platformFeeAmount: 5 });
      expect(t.taxSnapshot).toMatchObject({
        ruleVersion: TAX_RULE_VERSION,
        vatRate: 0.15,
        taxTreatment: 'full_value_standard',
        pricesIncludeVat: false,
      });
      expect(t.taxSnapshot.notes).toMatch(/PROVISIONAL/);
      expect(t.taxSnapshot.notes).toMatch(/tax advisor/i);
    });
  });
});
