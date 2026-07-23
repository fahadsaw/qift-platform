// Three-way Treasury Reconciliation — the PURE snapshot builder
// (Lane 2 PR 1). SC §10.3: attested safeguarding bank balance vs the
// ledger's safeguarding CASH view vs the ledger's OBLIGATIONS view,
// with every difference ENUMERATED, never summarized away.
//
// Purity law (same discipline as settlement-statement.ts): this
// module reads no clock, no DB, no randomness — it maps inputs to a
// deterministic snapshot whose canonical JSON is the source of truth
// and whose hash derives from the canonical bytes only. Same inputs
// → identical bytes → identical hash, years later (SC §34 posture).
//
// READ-ONLY over money: this module computes; it never posts.

import {
  canonicalJson,
  hashCanonical,
} from '../settlement/settlement-statement';

// The scope of the pilot reconciliation, versioned like every other
// pilot policy: the corporate MANUAL bank rail. Consumer-lane rows
// (MockGateway — no real cash) are enumerated as an EXCLUDED class,
// never silently dropped.
export const TREASURY_RECON_SCOPE = 'corporate_manual_rail@pilot-1';

// Snapshot format version — a format change bumps this, never edits
// an issued record.
// v2 (Lane 2 PR 2): adds the §26 non-cash closure classification —
// zero-net position extinguishments enumerate as internal-transfer-
// due, never as cash movements and never as mismatches.
export const TREASURY_SNAPSHOT_VERSION = 'treasury-3way@v2';

export type TreasuryMovement = {
  ledgerId: string;
  eventType: string;
  direction: 'in' | 'out';
  amountMinor: number;
  // Bank value date from the EVIDENCE row (receipt.receivedAt,
  // remittance.executedAt, refund.refundedAt). null = the evidence
  // row could not be resolved — an enumerated exception, never a
  // guess.
  valueDate: string | null;
  recordedAt: string;
  // Canonical/legal/bank reference for enumeration (QC number, QS
  // reference, bank ref). PII-free by construction.
  reference: string;
  storeId: string | null;
  evidenceRef: string | null;
  // §26 (Lane 2 PR 2): a zero-net position extinguishment — REAL in
  // the obligations view, but NOT a cash movement (no bank transfer
  // happened; the safeguarding→operating sweep is a future treasury
  // action). Enumerated as its own classification, never a mismatch.
  nonCash?: boolean;
};

export type TreasuryAttestationInput = {
  id: string;
  balanceMinor: number;
  asOfDate: string;
  source: string;
  evidenceRef: string;
};

export type TreasuryInputs = {
  accountType: string;
  currency: string;
  asOfDate: string;
  attestation: TreasuryAttestationInput | null;
  // Leg 2 — safeguarding CASH movements (receipts in; remittances,
  // safeguarding refunds, recovery draws out).
  cashMovements: TreasuryMovement[];
  // Leg 3 — OBLIGATION movements (payable accruals in; remittances,
  // recovery consumptions, safeguarding refunds out).
  obligationMovements: TreasuryMovement[];
  // Rows deliberately outside scope, counted so nothing silently
  // disappears (consumer lane, operating-account cash).
  excluded: Array<{ class: string; count: number; amountMinor: number }>;
};

export type TreasuryDifference = {
  kind:
    | 'bank_vs_ledger_cash'
    | 'cash_vs_obligations'
    | 'unresolved_evidence'
    | 'negative_bank_balance';
  deltaMinor: number;
  detail: string;
  ledgerId?: string;
  eventType?: string;
};

const byDeterministicOrder = (a: TreasuryMovement, b: TreasuryMovement) => {
  const av = a.valueDate ?? '9999-12-31T23:59:59.999Z';
  const bv = b.valueDate ?? '9999-12-31T23:59:59.999Z';
  if (av !== bv) return av < bv ? -1 : 1;
  return a.ledgerId < b.ledgerId ? -1 : a.ledgerId > b.ledgerId ? 1 : 0;
};

function splitByAsOf(movements: TreasuryMovement[], asOfDate: string) {
  const included: TreasuryMovement[] = [];
  const timing: TreasuryMovement[] = [];
  const unresolved: TreasuryMovement[] = [];
  for (const m of [...movements].sort(byDeterministicOrder)) {
    if (m.valueDate === null) unresolved.push(m);
    else if (m.valueDate <= asOfDate) included.push(m);
    // Recorded in the books with a bank value date AFTER the
    // attested balance date: a TIMING item — it explains nothing
    // about the past balance and is enumerated, not netted.
    else timing.push(m);
  }
  return { included, timing, unresolved };
}

const sumMinor = (ms: TreasuryMovement[]) =>
  ms.reduce((s, m) => s + (m.direction === 'in' ? m.amountMinor : -m.amountMinor), 0);

export function buildTreasurySnapshot(inputs: TreasuryInputs): {
  snapshot: Record<string, unknown>;
  canonical: string;
  hash: string;
  status: 'pending' | 'matched' | 'mismatched';
  ledgerCashMinor: number;
  obligationsMinor: number;
  bankVsCashMinor: number | null;
  cashVsObligationsMinor: number;
  differences: TreasuryDifference[];
} {
  const cash = splitByAsOf(inputs.cashMovements, inputs.asOfDate);
  const obligations = splitByAsOf(inputs.obligationMovements, inputs.asOfDate);

  const ledgerCashMinor = sumMinor(cash.included);
  const obligationsMinor = sumMinor(obligations.included);
  // §26: non-cash closures reduce OBLIGATIONS without touching cash —
  // the safeguarding account lawfully holds money that now belongs to
  // Qift's operating side, pending the physical internal sweep. That
  // exact amount is the enumerated reconciler between the two legs.
  const internalTransferDueMinor = obligations.included
    .filter((m) => m.nonCash)
    .reduce((t, m) => t + (m.direction === 'in' ? -m.amountMinor : m.amountMinor), 0);
  const rawCashVsObligationsMinor = ledgerCashMinor - obligationsMinor;
  const cashVsObligationsMinor =
    rawCashVsObligationsMinor - internalTransferDueMinor;
  const bankVsCashMinor = inputs.attestation
    ? inputs.attestation.balanceMinor - ledgerCashMinor
    : null;

  const differences: TreasuryDifference[] = [];
  if (bankVsCashMinor !== null && bankVsCashMinor !== 0) {
    differences.push({
      kind: 'bank_vs_ledger_cash',
      deltaMinor: bankVsCashMinor,
      detail:
        'Attested bank balance differs from the ledger safeguarding cash view at asOfDate (after timing items were set aside).',
    });
  }
  if (cashVsObligationsMinor !== 0) {
    // Break the internal asymmetry down per event type so the
    // investigator sees WHICH posting family diverged.
    const byEvent = new Map<string, number>();
    for (const m of cash.included) {
      byEvent.set(
        m.eventType,
        (byEvent.get(m.eventType) ?? 0) +
          (m.direction === 'in' ? m.amountMinor : -m.amountMinor),
      );
    }
    for (const m of obligations.included) {
      byEvent.set(
        m.eventType,
        (byEvent.get(m.eventType) ?? 0) -
          (m.direction === 'in' ? m.amountMinor : -m.amountMinor),
      );
    }
    const breakdown = [...byEvent.entries()]
      .filter(([, v]) => v !== 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    differences.push({
      kind: 'cash_vs_obligations',
      deltaMinor: cashVsObligationsMinor,
      detail: `Ledger cash view and obligations view disagree — posting asymmetry by event type (minor units): ${breakdown}`,
    });
  }
  // Review finding 5: a row copied into both legs must yield ONE
  // enumerated exception, not two — dedupe by ledgerId.
  const seenUnresolved = new Set<string>();
  for (const m of [...cash.unresolved, ...obligations.unresolved]) {
    if (seenUnresolved.has(m.ledgerId)) continue;
    seenUnresolved.add(m.ledgerId);
    differences.push({
      kind: 'unresolved_evidence',
      deltaMinor: m.direction === 'in' ? m.amountMinor : -m.amountMinor,
      detail: `Ledger row ${m.ledgerId} (${m.eventType}) has no resolvable evidence row — value date unknown.`,
      ledgerId: m.ledgerId,
      eventType: m.eventType,
    });
  }
  if (inputs.attestation && inputs.attestation.balanceMinor < 0) {
    differences.push({
      kind: 'negative_bank_balance',
      deltaMinor: inputs.attestation.balanceMinor,
      detail:
        'Attested safeguarding balance is NEGATIVE — client money must never be overdrawn.',
    });
  }

  // Review finding 1: 'pending' means ONLY "awaiting the bank leg".
  // Bank-independent defects (posting asymmetry, unresolved evidence)
  // are detected without an attestation and must enter the guarded
  // mismatched → investigated → resolved lifecycle immediately — a
  // detected defect never hides behind a waiting status.
  const status: 'pending' | 'matched' | 'mismatched' =
    differences.length > 0
      ? 'mismatched'
      : !inputs.attestation
        ? 'pending'
        : 'matched';

  const nonCashClosures = obligations.included.filter((m) => m.nonCash);
  const snapshot = {
    snapshotVersion: TREASURY_SNAPSHOT_VERSION,
    scope: TREASURY_RECON_SCOPE,
    accountType: inputs.accountType,
    currency: inputs.currency,
    asOfDate: inputs.asOfDate,
    attestation: inputs.attestation,
    legs: {
      bankBalanceMinor: inputs.attestation?.balanceMinor ?? null,
      ledgerCashMinor,
      obligationsMinor,
      internalTransferDueMinor,
    },
    deltas: {
      bankVsCashMinor,
      rawCashVsObligationsMinor,
      cashVsObligationsMinor, // adjusted for enumerated non-cash closures
    },
    // §26 closures, enumerated (req. 8: a classification value, not a
    // free-text exception).
    nonCashClosures,
    cash: {
      included: cash.included,
      timing: cash.timing,
      unresolved: cash.unresolved,
    },
    obligations: {
      included: obligations.included,
      timing: obligations.timing,
      unresolved: obligations.unresolved,
    },
    excluded: [...inputs.excluded].sort((a, b) =>
      a.class < b.class ? -1 : 1,
    ),
    differences,
    status,
  };
  const canonical = canonicalJson(snapshot);
  return {
    snapshot,
    canonical,
    hash: hashCanonical(canonical),
    status,
    ledgerCashMinor,
    obligationsMinor,
    bankVsCashMinor,
    cashVsObligationsMinor,
    differences,
  };
}
