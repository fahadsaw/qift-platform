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
};

export type RemittanceEvidence = {
  remittanceId: string;
  bankTransferReference: string; // SC §13.2: the bank's reference IS the evidence
  executedAt: string; // ISO — business fact, supplied
  amount: number;
};

export type SettlementStatement = {
  statementVersion: 'v1';
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

// The binding token of RULE 6: one hash names one frozen calculation.
export function calculationHash(snapshot: SettlementCalculation): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

export function statementHash(statement: SettlementStatement): string {
  return createHash('sha256').update(canonicalJson(statement)).digest('hex');
}

export function generateSettlementStatement(
  frozen: FrozenBatchRecord,
  opts: { issuedAt: string; remittance?: RemittanceEvidence | null },
): SettlementStatement {
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
