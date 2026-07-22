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
