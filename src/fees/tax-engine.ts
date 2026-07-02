// Qift TaxEngine — Saudi VAT (agent model).
//
// A versioned, SERVER-SIDE tax rule (the frontend never supplies a VAT
// number). computeTax freezes a taxSnapshot onto each invoice so a later
// rate/rule change never alters a historical invoice — bump
// TAX_RULE_VERSION whenever any constant below changes.
//
// COMMERCIAL MODEL — Qift is an AGENT, not a principal (canonical
// decision). Qift is NOT the seller of the goods and does not resell
// inventory: the merchant is the legal seller. Therefore Qift's VAT
// applies to the Qift SERVICE / platform fee ONLY. The gift (goods)
// value is the merchant's revenue — recorded here as facilitated /
// pass-through value and EXCLUDED from Qift's VAT base and from the Qift
// invoice total. Merchant goods VAT belongs on the separate merchant
// (goods) invoice, not on the Qift service invoice.
//
// STILL PROVISIONAL — although the agent classification is now settled,
// no VAT is remitted to ZATCA yet and the rate / e-invoicing mechanics
// are not advisor-confirmed for remittance. The remaining open question
// is only `pricesIncludeVat` (are catalog prices VAT-inclusive or
// exclusive?). Both conventions stay representable so a future answer is
// a constant + version bump, never a historical-row rewrite.

export const SAUDI_VAT_RATE = 0.15; // KSA standard rate
export const TAX_RULE_VERSION = 'sa-vat-agent-v1';

export type TaxTreatment =
  // Qift as principal (legacy): 15% VAT on (subtotal + platform fee).
  // Retained so any historical invoice frozen under it stays readable;
  // no new invoice is issued under this treatment.
  | 'full_value_standard'
  // Qift as agent (current default): 15% VAT on the Qift platform fee
  // only; the goods subtotal is facilitated pass-through, not Qift VAT.
  | 'agent_fee_only';

// DEFAULTS — Qift is an agent; VAT on the platform fee only.
export const DEFAULT_TAX_TREATMENT: TaxTreatment = 'agent_fee_only';
export const DEFAULT_PRICES_INCLUDE_VAT = false; // VAT added on top

export type TaxInput = {
  subtotalAmount: number; // gift value (unit * recipientCount) — merchant's
  platformFeeAmount: number; // Qift platform fee — Qift's revenue
  treatment?: TaxTreatment;
  pricesIncludeVat?: boolean;
  vatRate?: number; // defaults to the server-side SAUDI_VAT_RATE
};

export type TaxSnapshot = {
  ruleVersion: string;
  vatRate: number;
  taxTreatment: TaxTreatment;
  pricesIncludeVat: boolean;
  taxableBase: number; // net base the VAT was computed on (Qift fee, agent)
  vatAmount: number;
  // Goods value the merchant sells and Qift merely facilitates. EXCLUDED
  // from Qift's VAT base and Qift invoice total under the agent model
  // (0 under the legacy principal treatment). Frozen so the split is
  // auditable on the historical invoice.
  facilitatedValue: number;
  notes: string;
};

export type TaxBreakdown = {
  taxTreatment: TaxTreatment;
  pricesIncludeVat: boolean;
  taxableAmount: number; // net base VAT applies to (Qift fee under agent)
  vatRate: number;
  vatAmount: number; // VAT on the Qift fee only (agent)
  totalBeforeVat: number; // Qift charge, ex-VAT (the fee under agent)
  totalAmount: number; // Qift invoice total = fee + VAT on fee (agent)
  // Merchant goods value Qift facilitates but does not sell or invoice.
  facilitatedValue: number;
  taxSnapshot: TaxSnapshot;
};

const PROVISIONAL_NOTE =
  'Saudi VAT (agent model). Qift is an AGENT, not the seller: VAT applies ' +
  "to the Qift platform fee only; the goods value is the merchant's and " +
  'is excluded as facilitated pass-through. No VAT is remitted to ZATCA ' +
  'yet. Frozen on the invoice for historical correctness.';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeTax(input: TaxInput): TaxBreakdown {
  const taxTreatment = input.treatment ?? DEFAULT_TAX_TREATMENT;
  const pricesIncludeVat = input.pricesIncludeVat ?? DEFAULT_PRICES_INCLUDE_VAT;
  const vatRate = input.vatRate ?? SAUDI_VAT_RATE;

  const isAgent = taxTreatment === 'agent_fee_only';

  // What Qift actually charges the company under this treatment. Under
  // the agent model that is the platform fee ONLY — the goods subtotal
  // is the merchant's and never enters the Qift charge or its VAT.
  const qiftChargeBase = isAgent
    ? input.platformFeeAmount
    : input.subtotalAmount + input.platformFeeAmount;

  // Goods value Qift facilitates but does not sell (agent) — excluded
  // from Qift's VAT base and invoice total. Zero under the legacy
  // principal treatment, where Qift billed the full value itself.
  const facilitatedValue = isAgent ? round2(input.subtotalAmount) : 0;

  let taxableAmount: number;
  let vatAmount: number;
  let totalBeforeVat: number;
  let totalAmount: number;

  if (pricesIncludeVat) {
    // The Qift charge already includes VAT — extract the tax portion.
    taxableAmount = round2(qiftChargeBase / (1 + vatRate));
    vatAmount = round2(qiftChargeBase - taxableAmount);
    totalAmount = round2(qiftChargeBase);
    totalBeforeVat = round2(totalAmount - vatAmount);
  } else {
    // VAT added on top of the Qift charge.
    taxableAmount = round2(qiftChargeBase);
    vatAmount = round2(taxableAmount * vatRate);
    totalBeforeVat = round2(qiftChargeBase);
    totalAmount = round2(totalBeforeVat + vatAmount);
  }

  return {
    taxTreatment,
    pricesIncludeVat,
    taxableAmount,
    vatRate,
    vatAmount,
    totalBeforeVat,
    totalAmount,
    facilitatedValue,
    taxSnapshot: {
      ruleVersion: TAX_RULE_VERSION,
      vatRate,
      taxTreatment,
      pricesIncludeVat,
      taxableBase: taxableAmount,
      vatAmount,
      facilitatedValue,
      notes: PROVISIONAL_NOTE,
    },
  };
}

// ── Merchant goods leg (agent model) ────────────────────────────────
//
// The MERCHANT is the legal seller of the goods, so VAT on the goods
// belongs on the merchant (goods) invoice — under the merchant's VAT
// registration — never on the Qift service invoice. Qift generates the
// merchant invoice on the merchant's behalf; every amount below is
// merchant revenue, not Qift's.
//
// This is the OTHER HALF of the same agent ruleset computeTax
// implements (fee-leg VAT for Qift, goods-leg VAT for the merchant), so
// it shares SAUDI_VAT_RATE / TAX_RULE_VERSION / rounding. Adding it did
// NOT change any computeTax output, so the rule version is not bumped.

export const MERCHANT_GOODS_TAX_TREATMENT = 'merchant_goods_standard';

export type MerchantGoodsTaxInput = {
  goodsSubtotalAmount: number; // unit * recipientCount — merchant's goods
  pricesIncludeVat?: boolean;
  vatRate?: number; // defaults to the server-side SAUDI_VAT_RATE
};

export type MerchantGoodsTaxSnapshot = {
  ruleVersion: string;
  vatRate: number;
  taxTreatment: string; // MERCHANT_GOODS_TAX_TREATMENT
  pricesIncludeVat: boolean;
  taxableBase: number; // net goods base the merchant VAT applies to
  vatAmount: number;
  notes: string;
};

export type MerchantGoodsTaxBreakdown = {
  taxTreatment: string; // MERCHANT_GOODS_TAX_TREATMENT
  pricesIncludeVat: boolean;
  taxableAmount: number; // net goods base the merchant VAT applies to
  vatRate: number;
  vatAmount: number; // MERCHANT output VAT on the goods
  totalAmount: number; // goods total the company owes the merchant
  taxSnapshot: MerchantGoodsTaxSnapshot;
};

const MERCHANT_GOODS_NOTE =
  'Saudi VAT (agent model), merchant goods leg. The merchant is the ' +
  "legal seller: this VAT is the MERCHANT's output VAT on the goods, " +
  "recorded by Qift on the merchant's behalf — not Qift revenue, not " +
  'Qift VAT. No VAT is remitted to ZATCA yet. Frozen on the invoice ' +
  'for historical correctness.';

export function computeMerchantGoodsTax(
  input: MerchantGoodsTaxInput,
): MerchantGoodsTaxBreakdown {
  const pricesIncludeVat = input.pricesIncludeVat ?? DEFAULT_PRICES_INCLUDE_VAT;
  const vatRate = input.vatRate ?? SAUDI_VAT_RATE;
  const goods = input.goodsSubtotalAmount;

  let taxableAmount: number;
  let vatAmount: number;
  let totalAmount: number;

  if (pricesIncludeVat) {
    // The goods price already includes VAT — extract the tax portion.
    taxableAmount = round2(goods / (1 + vatRate));
    vatAmount = round2(goods - taxableAmount);
    totalAmount = round2(goods);
  } else {
    // VAT added on top of the goods base.
    taxableAmount = round2(goods);
    vatAmount = round2(taxableAmount * vatRate);
    totalAmount = round2(taxableAmount + vatAmount);
  }

  return {
    taxTreatment: MERCHANT_GOODS_TAX_TREATMENT,
    pricesIncludeVat,
    taxableAmount,
    vatRate,
    vatAmount,
    totalAmount,
    taxSnapshot: {
      ruleVersion: TAX_RULE_VERSION,
      vatRate,
      taxTreatment: MERCHANT_GOODS_TAX_TREATMENT,
      pricesIncludeVat,
      taxableBase: taxableAmount,
      vatAmount,
      notes: MERCHANT_GOODS_NOTE,
    },
  };
}
