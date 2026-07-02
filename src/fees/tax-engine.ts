// Qift TaxEngine — Saudi VAT v1.
//
// A versioned, SERVER-SIDE tax rule (the frontend never supplies a VAT
// number). computeTax freezes a taxSnapshot onto each invoice so a later
// rate/rule change never alters a historical invoice — bump
// TAX_RULE_VERSION whenever any constant below changes.
//
// ⚠️ PROVISIONAL — the two load-bearing questions below are NOT yet
// confirmed by a Saudi tax advisor, and NO VAT is remitted to ZATCA yet
// (this PR only records a snapshot for future correctness):
//   1. Is Qift PRINCIPAL (VAT on the full campaign value) or AGENT (VAT
//      only on the Qift platform fee)?  → `taxTreatment`.
//   2. Are catalog prices VAT-inclusive or exclusive?  → `pricesIncludeVat`.
// v1 defaults to the conservative principal / VAT-exclusive stance; both
// alternatives are representable so the answer changes a constant + a
// version bump, never historical rows.

export const SAUDI_VAT_RATE = 0.15; // KSA standard rate
export const TAX_RULE_VERSION = 'sa-vat-v1';

export type TaxTreatment =
  // Qift as principal: 15% VAT on (subtotal + platform fee).
  | 'full_value_standard'
  // Qift as agent: 15% VAT on the Qift platform fee only.
  | 'agent_fee_only';

// v1 DEFAULTS — provisional, see header.
export const DEFAULT_TAX_TREATMENT: TaxTreatment = 'full_value_standard';
export const DEFAULT_PRICES_INCLUDE_VAT = false; // VAT added on top

export type TaxInput = {
  subtotalAmount: number; // gift value (unit * recipientCount)
  platformFeeAmount: number; // Qift platform fee
  treatment?: TaxTreatment;
  pricesIncludeVat?: boolean;
  vatRate?: number; // defaults to the server-side SAUDI_VAT_RATE
};

export type TaxSnapshot = {
  ruleVersion: string;
  vatRate: number;
  taxTreatment: TaxTreatment;
  pricesIncludeVat: boolean;
  taxableBase: number; // net base the VAT was computed on
  vatAmount: number;
  notes: string;
};

export type TaxBreakdown = {
  taxTreatment: TaxTreatment;
  pricesIncludeVat: boolean;
  taxableAmount: number; // net base VAT applies to
  vatRate: number;
  vatAmount: number;
  totalBeforeVat: number; // net total (subtotal + fee, ex-VAT)
  totalAmount: number; // gross total the company owes (VAT-inclusive)
  taxSnapshot: TaxSnapshot;
};

const PROVISIONAL_NOTE =
  'PROVISIONAL Saudi VAT v1. Principal-vs-agent classification and VAT ' +
  'base are NOT yet confirmed by a tax advisor; no VAT is remitted to ' +
  'ZATCA yet. Frozen on the invoice for historical correctness.';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeTax(input: TaxInput): TaxBreakdown {
  const taxTreatment = input.treatment ?? DEFAULT_TAX_TREATMENT;
  const pricesIncludeVat = input.pricesIncludeVat ?? DEFAULT_PRICES_INCLUDE_VAT;
  const vatRate = input.vatRate ?? SAUDI_VAT_RATE;

  // The base the VAT applies to, per the (provisional) treatment.
  const grossBase =
    taxTreatment === 'agent_fee_only'
      ? input.platformFeeAmount
      : input.subtotalAmount + input.platformFeeAmount;

  let taxableAmount: number;
  let vatAmount: number;
  let totalBeforeVat: number;
  let totalAmount: number;

  if (pricesIncludeVat) {
    // Amounts already include VAT — extract the tax portion from the base.
    taxableAmount = round2(grossBase / (1 + vatRate));
    vatAmount = round2(grossBase - taxableAmount);
    totalAmount = round2(input.subtotalAmount + input.platformFeeAmount);
    totalBeforeVat = round2(totalAmount - vatAmount);
  } else {
    // VAT added on top of the base.
    taxableAmount = round2(grossBase);
    vatAmount = round2(taxableAmount * vatRate);
    totalBeforeVat = round2(input.subtotalAmount + input.platformFeeAmount);
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
    taxSnapshot: {
      ruleVersion: TAX_RULE_VERSION,
      vatRate,
      taxTreatment,
      pricesIncludeVat,
      taxableBase: taxableAmount,
      vatAmount,
      notes: PROVISIONAL_NOTE,
    },
  };
}
