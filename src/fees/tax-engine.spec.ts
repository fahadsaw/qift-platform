import {
  computeTax,
  computeMerchantGoodsTax,
  SAUDI_VAT_RATE,
  TAX_RULE_VERSION,
  DEFAULT_TAX_TREATMENT,
  MERCHANT_GOODS_TAX_TREATMENT,
  MERCHANT_NOT_VAT_REGISTERED_TAX_TREATMENT,
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
    it('carries the current rule version (bumped to v2 by FIN-1)', () => {
      expect(TAX_RULE_VERSION).toBe('sa-vat-agent-v2');
      const t = computeTax({ subtotalAmount: 100, platformFeeAmount: 5 });
      expect(t.taxSnapshot.ruleVersion).toBe('sa-vat-agent-v2');
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

  describe('computeMerchantGoodsTax (the merchant goods leg, FIN-1 VAT facts)', () => {
    it('VAT-registered merchant, prices EXCLUDE VAT: adds 15% on top', () => {
      // goods 5000 entered ex-VAT: merchant VAT 750; goods total 5750.
      const t = computeMerchantGoodsTax({
        goodsSubtotalAmount: 5000,
        vatRegistered: true,
        vatNumber: '310000000000003',
        pricesIncludeVat: false,
      });
      expect(t).toMatchObject({
        taxTreatment: MERCHANT_GOODS_TAX_TREATMENT,
        pricesIncludeVat: false,
        taxableAmount: 5000,
        vatRate: SAUDI_VAT_RATE,
        vatAmount: 750,
        totalAmount: 5750,
      });
    });

    it('VAT-registered merchant, prices INCLUDE VAT: extracts VAT from the shelf price', () => {
      // goods 5000 is the final displayed price: net 4347.83, VAT
      // 652.17, total stays 5000 — the company pays what the shelf says.
      const t = computeMerchantGoodsTax({
        goodsSubtotalAmount: 5000,
        vatRegistered: true,
        vatNumber: '310000000000003',
        pricesIncludeVat: true,
      });
      expect(t.taxableAmount).toBe(4347.83);
      expect(t.vatAmount).toBe(652.17);
      expect(t.totalAmount).toBe(5000); // gross unchanged
      expect(t.taxTreatment).toBe(MERCHANT_GOODS_TAX_TREATMENT);
    });

    it('NON-VAT-registered merchant: zero VAT, total equals the goods subtotal', () => {
      const t = computeMerchantGoodsTax({
        goodsSubtotalAmount: 5000,
        vatRegistered: false,
        pricesIncludeVat: true, // convention is irrelevant when unregistered
      });
      expect(t).toMatchObject({
        taxTreatment: MERCHANT_NOT_VAT_REGISTERED_TAX_TREATMENT,
        vatRate: 0,
        vatAmount: 0,
        totalAmount: 5000,
      });
      // The snapshot clearly states the reason no VAT was charged.
      expect(t.taxSnapshot.taxTreatment).toBe('merchant_not_vat_registered');
      expect(t.taxSnapshot.vatRegistered).toBe(false);
      expect(t.taxSnapshot.vatAmount).toBe(0);
      expect(t.taxSnapshot.notes).toMatch(/not.*vat-registered/i);
      expect(t.taxSnapshot.notes).toMatch(/no VAT is charged/i);
    });

    it('freezes the VAT facts into the snapshot (registration, number, convention, version)', () => {
      const t = computeMerchantGoodsTax({
        goodsSubtotalAmount: 5000,
        vatRegistered: true,
        vatNumber: '310000000000003',
        pricesIncludeVat: false,
      });
      expect(t.taxSnapshot).toMatchObject({
        ruleVersion: TAX_RULE_VERSION, // sa-vat-agent-v2
        vatRate: 0.15,
        taxTreatment: MERCHANT_GOODS_TAX_TREATMENT,
        vatRegistered: true,
        vatNumber: '310000000000003',
        pricesIncludeVat: false,
        taxableBase: 5000,
        vatAmount: 750,
      });
      expect(t.taxSnapshot.notes).toMatch(/merchant/i);
      expect(t.taxSnapshot.notes).toMatch(/not Qift revenue/i);
    });

    it('the Qift service invoice remains fee-only — unaffected by merchant VAT facts', () => {
      // Campaign of 500 SAR x 10 with a 150 fee. The Qift leg never
      // changes with the merchant's registration or price convention:
      const qift = computeTax({ subtotalAmount: 5000, platformFeeAmount: 150 });
      expect(qift.taxableAmount).toBe(150);
      expect(qift.totalAmount).toBe(172.5); // fee 150 + VAT 22.5, always

      // …while the goods leg varies per merchant facts:
      const registered = computeMerchantGoodsTax({
        goodsSubtotalAmount: 5000,
        vatRegistered: true,
        pricesIncludeVat: false,
      });
      const unregistered = computeMerchantGoodsTax({
        goodsSubtotalAmount: 5000,
        vatRegistered: false,
      });
      expect(registered.totalAmount).toBe(5750);
      expect(unregistered.totalAmount).toBe(5000);
      // Goods never leak into Qift's invoice in either case.
      expect(qift.totalAmount + registered.totalAmount).toBe(5922.5);
      expect(qift.totalAmount + unregistered.totalAmount).toBe(5172.5);
    });
  });
});
