// Qift Money — the Shared Financial Core's single money policy (FIN-3).
//
// WHY: money amounts were computed with raw floating-point arithmetic
// and stored in DOUBLE PRECISION columns. Binary floats cannot represent
// most decimal amounts exactly (19.99 * 3 === 59.96999999999999…), which
// is harmless for display but poison for settlement/PSP reconciliation
// and tax records. FIN-3 fixes both ends:
//   * STORAGE — financial-record tables (FinancialLedgerEntry,
//     CorporateInvoice, MerchantInvoice) now use exact NUMERIC columns.
//   * ARITHMETIC — every money computation routes through this module,
//     which does its math in INTEGER MINOR UNITS (halalas), where
//     floating point is exact (integers ≤ 2^53 are lossless).
//
// CURRENCY POLICY: SAR today (2 minor-unit digits). The registry below
// already carries the 3-decimal GCC currencies so international
// expansion is a table entry + input parameter, never a rewrite.
//
// WIRE FORMAT: the API keeps returning plain JSON numbers — Prisma
// Decimal values are converted at the response boundary by
// DecimalToNumberInterceptor (src/common) and at internal boundaries by
// moneyToNumber() below. Frontends never see Decimal strings.

export type CurrencyCode = 'SAR' | 'AED' | 'QAR' | 'BHD' | 'KWD' | 'OMR';

// ISO-4217 minor-unit digits. SAR/AED/QAR use 2; the three GCC dinars/
// rial use 3 (fils/baisa). Extend here for new markets — nothing else
// changes.
const CURRENCY_MINOR_DIGITS: Record<CurrencyCode, number> = {
  SAR: 2,
  AED: 2,
  QAR: 2,
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

export const DEFAULT_CURRENCY: CurrencyCode = 'SAR';

export function minorDigitsFor(currency: CurrencyCode = DEFAULT_CURRENCY) {
  return CURRENCY_MINOR_DIGITS[currency];
}

function scaleFor(currency: CurrencyCode): number {
  return 10 ** CURRENCY_MINOR_DIGITS[currency];
}

// Convert a major-unit amount to integer minor units (SAR → halalas).
// Math.round here is safe for our inputs: accumulated float drift on
// real-world amounts is ~1e-12 of a unit — twelve orders of magnitude
// below the 0.5-minor-unit rounding threshold.
export function toMinor(
  amount: number,
  currency: CurrencyCode = DEFAULT_CURRENCY,
): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`money: cannot convert non-finite amount ${amount}`);
  }
  return Math.round(amount * scaleFor(currency));
}

// Convert integer minor units back to a major-unit number.
export function fromMinor(
  minor: number,
  currency: CurrencyCode = DEFAULT_CURRENCY,
): number {
  return minor / scaleFor(currency);
}

// Round a major-unit amount to the currency's minor-unit precision
// (half-up via integer minor units). THE rounding authority — every
// engine rounds through here so there is exactly one rounding rule.
export function roundMoney(
  amount: number,
  currency: CurrencyCode = DEFAULT_CURRENCY,
): number {
  return fromMinor(toMinor(amount, currency), currency);
}

// Exact sum: each addend is snapped to minor units, summed as integers,
// then converted back. 0.1 + 0.2 === 0.3 here, always.
export function addMoney(
  amounts: number[],
  currency: CurrencyCode = DEFAULT_CURRENCY,
): number {
  const totalMinor = amounts.reduce((sum, a) => sum + toMinor(a, currency), 0);
  return fromMinor(totalMinor, currency);
}

// Exact multiply for (unit amount × integer count) — the invoice-line
// case. The unit amount is snapped to minor units FIRST, so
// 19.99 × 3 === 59.97 exactly, never 59.96999999999999.
export function mulMoney(
  unitAmount: number,
  count: number,
  currency: CurrencyCode = DEFAULT_CURRENCY,
): number {
  if (!Number.isInteger(count)) {
    throw new Error(`money: mulMoney count must be an integer, got ${count}`);
  }
  return fromMinor(toMinor(unitAmount, currency) * count, currency);
}

// Boundary converter: Prisma Decimal (or decimal-like string) → number.
// Reads from the NUMERIC columns come back as Prisma.Decimal objects;
// internal number-typed code (ledger inputs, audit metadata, summaries)
// converts through here. Structural check — no Prisma import — so pure
// callers and tests need no client dependency.
export function moneyToNumber(
  value: number | string | { toNumber(): number } | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
}
