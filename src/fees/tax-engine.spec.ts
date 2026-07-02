import {
  computeTax,
  SAUDI_VAT_RATE,
  TAX_RULE_VERSION,
  DEFAULT_TAX_TREATMENT,
} from './tax-engine';

describe('TaxEngine (Saudi VAT — agent model)', () => {
  describe('default: agent_fee_only, VAT-exclusive', () => {
    it('defaults to the agent treatment', () => {
      expect(DEFAULT_TAX_TREATMENT).toBe('agent_fee_only');
      const t = computeTax({ subtotalAmount: 5000, platformFeeAmount: 150 });
      expect(t.taxTreatment).toBe('agent_fee_only');
      expect(t.pricesIncludeVat).toBe(false);
    });

    it('calculates VAT on the platform fee ONLY, not the goods subtotal', () => {
      // subtotal 5000 is the merchant's goods value (facilitated); Qift's
      // VAT base is the 150 fee only. VAT 22.5; Qift invoice total 172.5.
      const t = computeTax({ subtotalAmount: 5000, platformFeeAmount: 150 });
      expect(t).toMatchObject({
        taxTreatment: 'agent_fee_only',
        pricesIncludeVat: false,
        taxableAmount: 150,
        vatRate: 0.15,
        vatAmount: 22.5,
        totalBeforeVat: 150,
        totalAmount: 172.5,
        facilitatedValue: 5000,
      });
    });

    it('totalAmount equals platform fee + VAT on the platform fee', () => {
      for (const [subtotal, fee] of [
        [5000, 150],
        [1234, 40],
        [999, 5],
      ] as const) {
        const t = computeTax({
          subtotalAmount: subtotal,
          platformFeeAmount: fee,
        });
        const expectedVat = Math.round(fee * 0.15 * 100) / 100;
        expect(t.vatAmount).toBe(expectedVat);
        expect(t.totalAmount).toBe(fee + expectedVat);
        expect(t.totalAmount).toBe(t.totalBeforeVat + t.vatAmount);
      }
    });

    it('does NOT treat the goods subtotal as Qift taxable revenue', () => {
      const t = computeTax({ subtotalAmount: 5000, platformFeeAmount: 150 });
      // The goods value appears nowhere in Qift's taxable base or total.
      expect(t.taxableAmount).toBe(150);
      expect(t.totalBeforeVat).toBe(150);
      expect(t.totalAmount).toBe(172.5);
      // It is recorded only as facilitated pass-through value.
      expect(t.facilitatedValue).toBe(5000);
      expect(t.taxableAmount).not.toBe(5000);
      expect(t.totalAmount).toBeLessThan(5000);
    });

    it('uses the SERVER-SIDE rate — no client input required', () => {
      const t = computeTax({ subtotalAmount: 100, platformFeeAmount: 5 });
      expect(t.vatRate).toBe(SAUDI_VAT_RATE); // 0.15, from the engine
      expect(t.vatAmount).toBe(0.75); // round2(5 * 0.15) — fee only
      expect(t.totalAmount).toBe(5.75);
      expect(t.facilitatedValue).toBe(100);
    });
  });

  describe('VAT-inclusive prices (extraction from the Qift fee)', () => {
    it('extracts VAT from the fee and keeps total = totalBeforeVat + vat', () => {
      const t = computeTax({
        subtotalAmount: 5000,
        platformFeeAmount: 150,
        pricesIncludeVat: true,
      });
      // agent model: only the 150 fee is the Qift charge and it already
      // includes VAT → net 130.43, VAT 19.57, total 150 (unchanged).
      expect(t.taxableAmount).toBe(130.43);
      expect(t.vatAmount).toBe(19.57);
      expect(t.totalAmount).toBe(150);
      expect(t.facilitatedValue).toBe(5000); // goods still excluded
      expect(t.totalAmount).toBe(
        Math.round((t.totalBeforeVat + t.vatAmount) * 100) / 100,
      );
    });
  });

  describe('legacy full_value_standard treatment (historical compatibility)', () => {
    it('still computes VAT on the full (subtotal + fee) base when asked', () => {
      // Retained so any invoice frozen under the old principal treatment
      // stays reproducible. subtotal 5000 + fee 150 = 5150 taxable; VAT
      // 772.5; total 5922.5; nothing is "facilitated" under principal.
      const t = computeTax({
        subtotalAmount: 5000,
        platformFeeAmount: 150,
        treatment: 'full_value_standard',
      });
      expect(t).toMatchObject({
        taxTreatment: 'full_value_standard',
        taxableAmount: 5150,
        vatAmount: 772.5,
        totalBeforeVat: 5150,
        totalAmount: 5922.5,
        facilitatedValue: 0,
      });
    });
  });

  describe('taxSnapshot (frozen for historical correctness)', () => {
    it('bumps the rule version to the agent rule', () => {
      expect(TAX_RULE_VERSION).toBe('sa-vat-agent-v1');
      const t = computeTax({ subtotalAmount: 100, platformFeeAmount: 5 });
      expect(t.taxSnapshot.ruleVersion).toBe('sa-vat-agent-v1');
    });

    it('records rule version, rate, treatment, facilitated value and a note', () => {
      const t = computeTax({ subtotalAmount: 5000, platformFeeAmount: 150 });
      expect(t.taxSnapshot).toMatchObject({
        ruleVersion: TAX_RULE_VERSION,
        vatRate: 0.15,
        taxTreatment: 'agent_fee_only',
        pricesIncludeVat: false,
        taxableBase: 150, // Qift fee only
        vatAmount: 22.5,
        facilitatedValue: 5000, // goods excluded from Qift VAT
      });
      expect(t.taxSnapshot.notes).toMatch(/agent/i);
      expect(t.taxSnapshot.notes).toMatch(/ZATCA/);
    });

    it('the snapshot mechanism is version-keyed so a future change is a bump', () => {
      // The same inputs always freeze the current rule version; changing a
      // constant would change the version, never rewrite a frozen row.
      const a = computeTax({ subtotalAmount: 200, platformFeeAmount: 10 });
      const b = computeTax({ subtotalAmount: 200, platformFeeAmount: 10 });
      expect(a.taxSnapshot).toEqual(b.taxSnapshot);
      expect(a.taxSnapshot.ruleVersion).toBe(TAX_RULE_VERSION);
    });
  });
});
