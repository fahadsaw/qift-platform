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
// are not advisor-confirmed for remittance. FIN-1 made the two open
// conventions PER-MERCHANT facts instead of global guesses: the goods
// leg is gated on the merchant's VAT registration, and the price
// convention (inclusive/exclusive) comes from the Store row. Both stay
// representable so any future advisor correction is a constant +
// version bump, never a historical-row rewrite.
//
// VERSION HISTORY
//   sa-vat-v1        — principal/full-value (legacy; frozen rows only).
//   sa-vat-agent-v1  — agent flip: fee-leg VAT for Qift; goods leg
//                      assumed every merchant VAT-registered.
//   sa-vat-agent-v2  — FIN-1: goods leg gated on per-merchant
//                      vatRegistered (+ merchant_not_vat_registered
//                      treatment) and per-merchant pricesIncludeVat;
//                      snapshot carries the registration facts.
//   sa-vat-agent-v3  — Track C PR 1 (Settlement Validation Pack F5 /
//                      S11; Settlement Constitution §34.4): ALL tax
//                      arithmetic moves to exact integer minor units.
//                      Identical results everywhere except exact-
//                      halfway inputs, where IEEE doubles previously
//                      rounded DOWN (fee 41.30 → VAT 6.19) against the
//                      Financial Constitution Ch. 5.2 half-up law
//                      (correct: 6.20). Same treatments, same rates.

import { fromMinor, toMinor } from './money';

export const SAUDI_VAT_RATE = 0.15; // KSA standard rate
export const TAX_RULE_VERSION = 'sa-vat-agent-v3';

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

// v3 — EXACT integer-minor-unit arithmetic (FC Ch. 5.2; Settlement
// Constitution §34.4: no floating-point path may influence a stored
// amount). Rates are scaled to basis points (4 dp) so every VAT
// computation is pure integer math with explicit round-half-up at the
// single division — the S11 halfway case (41.30 × 15% = 619.5 halalas)
// rounds UP to 6.20 by law, where IEEE doubles drifted to 6.19.
const RATE_SCALE = 10_000;

function rateBasisPoints(rate: number): number {
  return Math.round(rate * RATE_SCALE);
}

// v3 domain law: tax bases are non-negative. Credit/refund flows pass
// positive magnitudes and apply sign at posting (documents reverse via
// credit notes, never negative tax computation) — a negative operand
// here would floor toward −∞ instead of half-up, so it is refused.
function assertNonNegativeMinor(minor: number): void {
  if (minor < 0) {
    throw new Error('tax_engine_negative_base_unsupported');
  }
}

// VAT on an exclusive base: minor * rate, half-up, in integers.
function vatOnMinor(baseMinor: number, rateBp: number): number {
  assertNonNegativeMinor(baseMinor);
  const scaled = baseMinor * rateBp;
  const q = Math.floor(scaled / RATE_SCALE);
  const r = scaled % RATE_SCALE;
  return q + (2 * r >= RATE_SCALE ? 1 : 0);
}

// Net extraction from a VAT-inclusive gross: gross / (1 + rate),
// half-up, in integers. VAT is the complement (gross − net), so the
// pair always sums exactly to the gross — no independent-rounding leak.
function extractNetMinor(grossMinor: number, rateBp: number): number {
  assertNonNegativeMinor(grossMinor);
  const den = RATE_SCALE + rateBp;
  const num = grossMinor * RATE_SCALE;
  const q = Math.floor(num / den);
  const r = num % den;
  return q + (2 * r >= den ? 1 : 0);
}

// Major-unit boundary: inputs arrive as SAR majors; all computation is
// minor-unit; outputs return to majors via the Money policy.
function round2(n: number): number {
  return fromMinor(toMinor(n, 'SAR'), 'SAR');
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

  const rateBp = rateBasisPoints(vatRate);
  const chargeMinor = toMinor(qiftChargeBase, 'SAR');

  if (pricesIncludeVat) {
    // The Qift charge already includes VAT — extract the tax portion.
    // Net by half-up division; VAT as the exact complement.
    const netMinor = extractNetMinor(chargeMinor, rateBp);
    taxableAmount = fromMinor(netMinor, 'SAR');
    vatAmount = fromMinor(chargeMinor - netMinor, 'SAR');
    totalAmount = fromMinor(chargeMinor, 'SAR');
    totalBeforeVat = taxableAmount;
  } else {
    // VAT added on top of the Qift charge.
    const vatMinor = vatOnMinor(chargeMinor, rateBp);
    taxableAmount = fromMinor(chargeMinor, 'SAR');
    vatAmount = fromMinor(vatMinor, 'SAR');
    totalBeforeVat = taxableAmount;
    totalAmount = fromMinor(chargeMinor + vatMinor, 'SAR');
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
// FIN-1 — the goods VAT is governed by two PER-MERCHANT facts, frozen
// from the Store row at issuance:
//   * vatRegistered (REQUIRED input — the caller must state the fact;
//     there is no safe default for charging tax): an unregistered
//     merchant (below the KSA SAR 375k mandatory threshold) must not
//     charge VAT — vatRate/vatAmount are 0 and the snapshot says
//     'merchant_not_vat_registered'.
//   * pricesIncludeVat: true = the entered catalog price is the final
//     shelf price and VAT is EXTRACTED from it (KSA retail norm);
//     false = VAT is added ON TOP.
//
// This is the OTHER HALF of the same agent ruleset computeTax
// implements (fee-leg VAT for Qift, goods-leg VAT for the merchant), so
// it shares SAUDI_VAT_RATE / TAX_RULE_VERSION / rounding.

export const MERCHANT_GOODS_TAX_TREATMENT = 'merchant_goods_standard';
export const MERCHANT_NOT_VAT_REGISTERED_TAX_TREATMENT =
  'merchant_not_vat_registered';

export type MerchantGoodsTaxInput = {
  goodsSubtotalAmount: number; // unit * recipientCount — merchant's goods
  // REQUIRED: is the merchant VAT-registered? No default — whether tax
  // is charged on a legal document must be a stated fact, never an
  // assumption.
  vatRegistered: boolean;
  // The merchant's VAT registration number — echoed into the snapshot
  // so the frozen invoice can name the registration it was issued
  // under. Not used in any computation.
  vatNumber?: string | null;
  pricesIncludeVat?: boolean;
  vatRate?: number; // defaults to the server-side SAUDI_VAT_RATE
};

export type MerchantGoodsTaxSnapshot = {
  ruleVersion: string;
  vatRate: number;
  taxTreatment: string; // merchant_goods_standard | merchant_not_vat_registered
  vatRegistered: boolean;
  vatNumber: string | null;
  pricesIncludeVat: boolean;
  taxableBase: number; // net goods base the merchant VAT applies to
  vatAmount: number;
  notes: string;
};

export type MerchantGoodsTaxBreakdown = {
  taxTreatment: string; // merchant_goods_standard | merchant_not_vat_registered
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

const MERCHANT_NOT_REGISTERED_NOTE =
  'Saudi VAT (agent model), merchant goods leg — ' +
  'merchant_not_vat_registered: the merchant (legal seller) is NOT ' +
  'VAT-registered, so no VAT is charged on the goods (KSA mandatory ' +
  'registration threshold SAR 375k). The total equals the goods ' +
  'subtotal. Not Qift revenue, not Qift VAT. Frozen on the invoice ' +
  'for historical correctness.';

export function computeMerchantGoodsTax(
  input: MerchantGoodsTaxInput,
): MerchantGoodsTaxBreakdown {
  const pricesIncludeVat = input.pricesIncludeVat ?? DEFAULT_PRICES_INCLUDE_VAT;
  const vatNumber = input.vatNumber ?? null;
  const goods = input.goodsSubtotalAmount;

  // Unregistered merchant: no VAT on the goods, whatever the price
  // convention — the entered price IS the price.
  if (!input.vatRegistered) {
    const totalAmount = round2(goods);
    return {
      taxTreatment: MERCHANT_NOT_VAT_REGISTERED_TAX_TREATMENT,
      pricesIncludeVat,
      taxableAmount: totalAmount,
      vatRate: 0,
      vatAmount: 0,
      totalAmount,
      taxSnapshot: {
        ruleVersion: TAX_RULE_VERSION,
        vatRate: 0,
        taxTreatment: MERCHANT_NOT_VAT_REGISTERED_TAX_TREATMENT,
        vatRegistered: false,
        vatNumber,
        pricesIncludeVat,
        taxableBase: totalAmount,
        vatAmount: 0,
        notes: MERCHANT_NOT_REGISTERED_NOTE,
      },
    };
  }

  const vatRate = input.vatRate ?? SAUDI_VAT_RATE;

  let taxableAmount: number;
  let vatAmount: number;
  let totalAmount: number;

  const rateBp = rateBasisPoints(vatRate);
  const goodsMinor = toMinor(goods, 'SAR');

  if (pricesIncludeVat) {
    // The goods price already includes VAT — extract the tax portion
    // (net by half-up division; VAT as the exact complement).
    const netMinor = extractNetMinor(goodsMinor, rateBp);
    taxableAmount = fromMinor(netMinor, 'SAR');
    vatAmount = fromMinor(goodsMinor - netMinor, 'SAR');
    totalAmount = fromMinor(goodsMinor, 'SAR');
  } else {
    // VAT added on top of the goods base.
    const vatMinor = vatOnMinor(goodsMinor, rateBp);
    taxableAmount = fromMinor(goodsMinor, 'SAR');
    vatAmount = fromMinor(vatMinor, 'SAR');
    totalAmount = fromMinor(goodsMinor + vatMinor, 'SAR');
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
      vatRegistered: true,
      vatNumber,
      pricesIncludeVat,
      taxableBase: taxableAmount,
      vatAmount,
      notes: MERCHANT_GOODS_NOTE,
    },
  };
}
