// Settlement Statement — CONSTITUTIONAL OUTPUT (permanent RULE 4).
//
// Enacted by founder directive after PR #84 approval: the Settlement
// Statement is a constitutional output — replay MUST regenerate the
// IDENTICAL statement. This module is therefore a PURE FUNCTION over
// frozen data (SC v2.0 §15.1 shape, §34 Deterministic Replay Law):
//
//   - inputs are the batch's FROZEN record (QS, composition,
//     calculationSnapshot) + evidence facts (issuedAt, remittance) —
//     every date is a supplied business fact, never a machine clock;
//   - the §4 lines are carried VERBATIM from the frozen calculation
//     snapshot — this module NEVER recomputes money (recomputation
//     for verification lives in settlement-execution-binding.ts,
//     which compares and refuses, never substitutes);
//   - no I/O, no clock, no randomness, no framework — same frozen
//     inputs on any machine at any date produce the byte-identical
//     statement and hash.
//
// Hashing: canonicalJson (recursive key-sort) + sha256. The
// calculation hash over the frozen snapshot is ALSO the binding token
// of the Preview → Approval → Execute chain (RULE 6).
//
// Pinned by settlement-rules.spec.ts (RULE 4). Changing this module's
// output shape is a statement-format version bump (statementVersion),
// never an in-place mutation — issued statements are immutable.

import { createHash } from 'crypto';
import type { SettlementCalculation } from './settlement-calculator';

export type FrozenCompositionEntry = {
  itemId: string;
  occurrenceType: string;
  occurrenceId: string;
  amount: number;
  currency: string;
  // Canonical references denormalized at assembly (RC Ch. 14.4) —
  // carried verbatim when present.
  references?: Record<string, string | null>;
};

export type FrozenBatchRecord = {
  settlementId: string;
  settlementReference: string; // QS
  storeId: string;
  currency: string;
  windowType: string;
  composition: readonly FrozenCompositionEntry[];
  calculationSnapshot: SettlementCalculation;
  // §7.4 (SETTLE-3b): the per-receivable offsets behind the §4
  // receivableRecovery line — frozen at assembly; §34 replay
  // recomputes the calculator WITH these adjustments. Null/absent for
  // batches assembled before recovery existed.
  recoveryAllocation?: ReadonlyArray<{
    receivableId: string;
    occurrenceId: string;
    amount: number;
    amountRecoveredAtPlan: number;
    balanceAfter: number;
  }> | null;
};

export type RemittanceEvidence = {
  remittanceId: string;
  bankTransferReference: string; // SC §13.2: the bank's reference IS the evidence
  executedAt: string; // ISO — business fact, supplied
  amount: number;
};

// SC §26 (Lane 2 PR 2): the statement-only close facts. Every field
// is a SUPPLIED stored fact (like remittance evidence) except the
// openingPosition and the no-transfer text, which the generator
// derives PURELY from the frozen lines / a fixed constant.
export type ZeroNetClosureFacts = {
  closureType: 'ZERO_NET_NO_TRANSFER';
  closedAt: string; // ISO — recording instant of the close (stored fact)
  issuedUnderReplayEngine: string; // replay-engine version at issuance
};

// The explicit legal text (SC §26): the statement IS the instrument
// of closure — fixed bytes, part of the hashed document.
export const ZERO_NET_NO_TRANSFER_TEXT =
  'No bank transfer occurred. The frozen net of this settlement batch is exactly zero; this Settlement Statement is the sole and complete instrument of closure (Settlement Constitution §26). No remittance exists for this batch and none is due.';

export type SettlementStatement = {
  statementVersion: 'v1' | 'v2';
  settlementReference: string;
  settlementId: string;
  storeId: string;
  currency: string;
  windowType: string;
  issuedAt: string; // supplied business fact
  coveredOccurrences: Array<{
    occurrenceType: string;
    occurrenceId: string;
    amount: number;
    currency: string;
    references: Record<string, string | null>;
  }>;
  // The §4 enumeration, VERBATIM from the frozen snapshot.
  lines: SettlementCalculation['lines'];
  netAmount: number;
  itemCount: number;
  remittance: RemittanceEvidence | null;
  calculationHash: string;
  // Present ONLY on §26 statement-only closes (statementVersion v2).
  // canonicalJson drops undefined — every v1 remitted statement's
  // bytes are UNCHANGED by this field's existence.
  closure?: {
    closureType: 'ZERO_NET_NO_TRANSFER';
    noTransferStatement: string;
    closedAt: string;
    issuedUnderReplayEngine: string;
    // The signed merchant position this close extinguishes, carried
    // from the FROZEN lines verbatim (never recomputed): payables
    // gross, receivable recovery consumed, net — exactly zero.
    openingPosition: {
      merchantGross: number;
      receivableRecovery: number;
      net: number;
    };
  };
};

// Recursive stable-key-order JSON: the same data always serializes to
// the same bytes, regardless of construction order. Arrays keep their
// order (composition order is part of the frozen record, §34.4).
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

// STATEMENT HARDENING (req. 1+2): the canonical JSON string is THE
// source of truth, and every hash is computed from those exact bytes
// and NOTHING else — hashCanonical is the single digest primitive;
// statementHash/calculationHash are canonicalJson ∘ hashCanonical by
// construction. Presentation layers (print, HTML, exports) derive
// from the canonical string and add no data — none of that machinery
// may live in this module (pinned).
export function hashCanonical(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

// The binding token of RULE 6: one hash names one frozen calculation.
export function calculationHash(snapshot: SettlementCalculation): string {
  return hashCanonical(canonicalJson(snapshot));
}

export function statementHash(statement: SettlementStatement): string {
  return hashCanonical(canonicalJson(statement));
}

// ── Digital-signature seam (HARDENING req. 3) ────────────────────────
// A signature signs the CANONICAL DIGEST — the sha256 of the canonical
// JSON bytes — never the payload object, a rendering, or a re-
// serialization. Signers (Qift seal today-shaped, regulator seals
// later) attach as append-only envelope records; verification is:
//   verify(signature, signableDigest(statement), publicKey(keyId)).
export type SignatureEnvelope = {
  algorithm: string; // e.g. 'ed25519', 'rsa-pss-sha256'
  keyId: string; // Ch. 14-recorded signing-key identity
  signature: string; // base64
  signedBy: string;
  signedAt: string; // ISO — recorded fact
};

export function signableDigest(statement: SettlementStatement): string {
  return statementHash(statement);
}

export function generateSettlementStatement(
  frozen: FrozenBatchRecord,
  opts: {
    issuedAt: string;
    remittance?: RemittanceEvidence | null;
    // SC §26: supplying closure facts produces the v2 statement-only
    // close variant — remittance MUST be null/absent with it.
    closure?: ZeroNetClosureFacts | null;
  },
): SettlementStatement {
  if (opts.closure && opts.remittance) {
    // A close cannot both remit and not-remit — refusing here keeps
    // the document space unambiguous forever.
    throw new Error('statement_closure_and_remittance_exclusive');
  }
  if (opts.closure) {
    const lines = frozen.calculationSnapshot.lines as Record<string, number>;
    return {
      statementVersion: 'v2',
      settlementReference: frozen.settlementReference,
      settlementId: frozen.settlementId,
      storeId: frozen.storeId,
      currency: frozen.currency,
      windowType: frozen.windowType,
      issuedAt: opts.issuedAt,
      coveredOccurrences: frozen.composition.map((co) => ({
        occurrenceType: co.occurrenceType,
        occurrenceId: co.occurrenceId,
        amount: co.amount,
        currency: co.currency,
        references: co.references ?? {},
      })),
      // VERBATIM — never recomputed here (RULE 4).
      lines: frozen.calculationSnapshot.lines,
      netAmount: frozen.calculationSnapshot.netAmount,
      itemCount: frozen.calculationSnapshot.itemCount,
      remittance: null,
      calculationHash: calculationHash(frozen.calculationSnapshot),
      closure: {
        closureType: opts.closure.closureType,
        noTransferStatement: ZERO_NET_NO_TRANSFER_TEXT,
        closedAt: opts.closure.closedAt,
        issuedUnderReplayEngine: opts.closure.issuedUnderReplayEngine,
        openingPosition: {
          merchantGross: lines.merchantGross ?? 0,
          receivableRecovery: lines.receivableRecovery ?? 0,
          net: frozen.calculationSnapshot.netAmount,
        },
      },
    };
  }
  return {
    statementVersion: 'v1',
    settlementReference: frozen.settlementReference,
    settlementId: frozen.settlementId,
    storeId: frozen.storeId,
    currency: frozen.currency,
    windowType: frozen.windowType,
    issuedAt: opts.issuedAt,
    coveredOccurrences: frozen.composition.map((c) => ({
      occurrenceType: c.occurrenceType,
      occurrenceId: c.occurrenceId,
      amount: c.amount,
      currency: c.currency,
      references: c.references ?? {},
    })),
    // VERBATIM — never recomputed here (RULE 4).
    lines: frozen.calculationSnapshot.lines,
    netAmount: frozen.calculationSnapshot.netAmount,
    itemCount: frozen.calculationSnapshot.itemCount,
    remittance: opts.remittance ?? null,
    calculationHash: calculationHash(frozen.calculationSnapshot),
  };
}
