// The §4 settlement calculator (Track C PR 1).
//
// Settlement Constitution v2.0 §4: the net settlement of a batch is an
// ENUMERATED, SIGNED sum — every line traceable to ledger postings —
// computed per (merchant, currency) in integer minor units.
//
// THE ONE-CALCULATOR LAW (§30.3): simulation and execution MUST run
// this exact code path. This module is therefore pure — no I/O, no
// clock, no randomness — which is also what §34 (Deterministic Replay
// Law) demands: same frozen inputs → same output, on any machine, at
// any date.
//
// Lines not yet reachable in the foundation (refunds, chargebacks,
// reserves, recoveries — they arrive with the receipts/remittance PRs)
// are structurally present and required to be zero until their
// producers exist: the enumeration is closed law, not a growing list.

import { fromMinor, toMinor, type CurrencyCode } from '../fees/money';

// 2-dp currencies ONLY until the FC Ch. 5.4 storage-widening
// migration exists — settlement rows store NUMERIC(12,2), and a 3-dp
// currency (BHD/KWD/OMR) would be silently rounded by the database.
// Widening first, then registry addition (review finding 11a).
const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(['SAR', 'AED', 'QAR']);

export function asCurrencyCode(raw: string): CurrencyCode {
  const c = raw.toUpperCase();
  if (!KNOWN_CURRENCIES.has(c)) {
    // FC Ch. 5.4 storage law: an unregistered currency has no defined
    // scale — refusing is the only lawful move.
    throw new Error(`settlement_unknown_currency:${raw}`);
  }
  return c as CurrencyCode;
}

export type SettlementItemInput = {
  itemId: string;
  occurrenceType: string;
  occurrenceId: string;
  amount: number; // major units, exact NUMERIC from the row
  currency: string;
  // Canonical references carried into the frozen composition (§34.2).
  references?: Record<string, string | null>;
};

export type SettlementAdjustments = {
  // §4 lines. All default 0 in the foundation; producers land with
  // their own PRs and must post ledger legs the lines trace to.
  marketplaceAdjustments?: number;
  refunds?: number;
  chargebacks?: number;
  reserveHeld?: number;
  reserveReleased?: number;
  manualAdjustments?: number;
  receivableRecovery?: number;
};

export type SettlementCalculation = {
  currency: string;
  lines: {
    merchantGross: number;
    marketplaceAdjustments: number;
    // ZERO in every currently reachable flow (§4 v2.0 clarification):
    // two-invoice mode — the fee was never merchant money; netting
    // mode — the fee departed at the collection posting. The line
    // exists for the future merchant-side take-rate (FC Ch. 11).
    qiftFees: 0;
    taxes: 0; // tax rides its own line's frozen documents (§4) — never recomputed here
    refunds: number;
    chargebacks: number;
    reserveHeld: number;
    reserveReleased: number;
    manualAdjustments: number;
    receivableRecovery: number;
  };
  netAmount: number; // may be zero or NEGATIVE (§4: zero-net batches still issue statements)
  itemCount: number;
};

export class MixedCurrencyError extends Error {
  constructor(a: string, b: string) {
    // §4 / FC Ch. 5.4: amounts in different currencies NEVER sum.
    super(`settlement_currencies_never_sum:${a}:${b}`);
  }
}

export function calculateSettlement(
  items: readonly SettlementItemInput[],
  adjustments: SettlementAdjustments = {},
): SettlementCalculation {
  if (items.length === 0) {
    throw new Error('settlement_empty_composition');
  }
  const currency = asCurrencyCode(items[0].currency);
  let grossMinor = 0;
  for (const item of items) {
    const c = asCurrencyCode(item.currency);
    if (c !== currency) throw new MixedCurrencyError(currency, c);
    grossMinor += toMinor(item.amount, currency);
  }

  const m = (v: number | undefined) => toMinor(v ?? 0, currency);
  const marketplaceMinor = m(adjustments.marketplaceAdjustments);
  const refundsMinor = m(adjustments.refunds);
  const chargebacksMinor = m(adjustments.chargebacks);
  const reserveHeldMinor = m(adjustments.reserveHeld);
  const reserveReleasedMinor = m(adjustments.reserveReleased);
  const manualMinor = m(adjustments.manualAdjustments);
  const recoveryMinor = m(adjustments.receivableRecovery);

  // §4: NET = gross ± marketplace − refunds − chargebacks − reserveHeld
  //          + reserveReleased ± manual − receivableRecovery
  // (fees and taxes lines are structurally zero — see the type).
  const netMinor =
    grossMinor +
    marketplaceMinor -
    refundsMinor -
    chargebacksMinor -
    reserveHeldMinor +
    reserveReleasedMinor +
    manualMinor -
    recoveryMinor;

  return {
    currency,
    lines: {
      merchantGross: fromMinor(grossMinor, currency),
      marketplaceAdjustments: fromMinor(marketplaceMinor, currency),
      qiftFees: 0,
      taxes: 0,
      refunds: fromMinor(refundsMinor, currency),
      chargebacks: fromMinor(chargebacksMinor, currency),
      reserveHeld: fromMinor(reserveHeldMinor, currency),
      reserveReleased: fromMinor(reserveReleasedMinor, currency),
      manualAdjustments: fromMinor(manualMinor, currency),
      receivableRecovery: fromMinor(recoveryMinor, currency),
    },
    netAmount: fromMinor(netMinor, currency),
    itemCount: items.length,
  };
}
