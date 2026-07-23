// FINANCE OPS ERROR CONTRACT (founder closure task, 2026-07-23).
//
// PRESENTATION LAYER ONLY. This module defines the stable HTTP
// contract for the Finance Ops Console's refusals: which status each
// known refusal carries and the canonical machine-readable `code` the
// response body exposes. It changes NO financial calculation, NO
// settlement state machine, NO approval rule, and NO schema — every
// refusal CONDITION remains exactly where the services enforce it;
// only the HTTP response of an already-thrown refusal is shaped here.
//
// Contract (founder-enumerated):
//   stale preview / hash mismatch / changed-or-closed batch → 409
//   executor-in-approvers / proposer-approves / attester-resolves → 409
//   missing permission → 403 (guards, unchanged)
//   malformed input → 400 (services, unchanged)
//   tenant-scoped entity not found → 404 (services, unchanged)
//   genuinely unexpected → 500 with Nest's sanitized fixed body
//     {"statusCode":500,"message":"Internal server error"} — never a
//     stack trace, internal id, or financial metadata.
//
// Response body for mapped refusals:
//   { statusCode, error, message: <canonical>, code: <canonical>,
//     reason: <the specific legacy code, verbatim> }
// `code` is the ONLY field clients key behavior on; `reason` preserves
// the finer-grained legacy string (still stable) for precise operator
// messages; `message` mirrors `code` for Nest convention. Unmapped
// machine-code refusals pass through with `code` echoed from their
// message; human-sentence bodies (guards, validators) pass through
// untouched.

import { IllegalExecutionBinding } from '../settlement/settlement-execution-binding';

export const FINANCE_OPS_ERROR_CONTRACT_VERSION = 'finops-errors@v1';

// ── Canonical business-conflict codes (all HTTP 409) ───────────────
export const CANONICAL = {
  PREVIEW_STALE: 'settlement_preview_stale',
  CALC_HASH_MISMATCH: 'settlement_calculation_hash_mismatch',
  BATCH_STATE_CONFLICT: 'settlement_batch_state_conflict',
  APPROVAL_MISSING: 'settlement_approval_missing',
  APPROVAL_EXPIRED: 'settlement_approval_expired',
  EXECUTOR_IS_FINAL_APPROVER: 'settlement_executor_is_final_approver',
  APPROVER_IS_PROPOSER: 'settlement_approver_is_proposer',
  ATTESTER_CANNOT_RESOLVE: 'treasury_attester_cannot_resolve',
  GATES_NOT_ATTESTED: 'financial_gates_not_attested',
} as const;

export type CanonicalCode = (typeof CANONICAL)[keyof typeof CANONICAL];

// ── Legacy refusal code (base, before any ':' suffix) → contract ───
// Every entry re-emits as 409 with the canonical `code`; the original
// full string (suffix included) is preserved as `reason`. Entries
// whose current HTTP status is 400 are STATE facts, not malformed
// input — the founder taxonomy corrects them to 409 at this boundary.
export const LEGACY_TO_CANONICAL: Readonly<Record<string, CanonicalCode>> = {
  // Stale/missing preview act
  preview_act_required: CANONICAL.PREVIEW_STALE,
  // Submitted hash no longer names the frozen calculation
  preview_hash_mismatch: CANONICAL.CALC_HASH_MISMATCH,
  approval_snapshot_stale: CANONICAL.CALC_HASH_MISMATCH,
  // Batch is not in the state the act requires / already closed
  preview_requires_ready: CANONICAL.BATCH_STATE_CONFLICT,
  approval_requires_ready: CANONICAL.BATCH_STATE_CONFLICT,
  execution_requires_ready: CANONICAL.BATCH_STATE_CONFLICT,
  batch_drifted: CANONICAL.BATCH_STATE_CONFLICT,
  settlement_already_remitted: CANONICAL.BATCH_STATE_CONFLICT,
  settlement_closed_zero_net: CANONICAL.BATCH_STATE_CONFLICT,
  execution_use_zero_net_close: CANONICAL.BATCH_STATE_CONFLICT,
  execution_requires_positive_net: CANONICAL.BATCH_STATE_CONFLICT,
  zero_net_close_requires_exact_zero: CANONICAL.BATCH_STATE_CONFLICT,
  settled_without_remittance: CANONICAL.BATCH_STATE_CONFLICT,
  batch_proposer_unknown: CANONICAL.BATCH_STATE_CONFLICT,
  settlement_batch_contended: CANONICAL.BATCH_STATE_CONFLICT,
  settlement_items_contended: CANONICAL.BATCH_STATE_CONFLICT,
  receipt_invoice_not_receivable: CANONICAL.BATCH_STATE_CONFLICT,
  // Approvals absent or insufficient for the required level
  insufficient_approvals: CANONICAL.APPROVAL_MISSING,
  // §33 separation
  approver_cannot_be_proposer: CANONICAL.APPROVER_IS_PROPOSER,
  // Canonical codes emitted directly by services map to themselves so
  // the filter normalizes their body shape too.
  settlement_preview_stale: CANONICAL.PREVIEW_STALE,
  settlement_calculation_hash_mismatch: CANONICAL.CALC_HASH_MISMATCH,
  settlement_batch_state_conflict: CANONICAL.BATCH_STATE_CONFLICT,
  settlement_approval_missing: CANONICAL.APPROVAL_MISSING,
  settlement_approval_expired: CANONICAL.APPROVAL_EXPIRED,
  settlement_executor_is_final_approver: CANONICAL.EXECUTOR_IS_FINAL_APPROVER,
  settlement_approver_is_proposer: CANONICAL.APPROVER_IS_PROPOSER,
  treasury_attester_cannot_resolve: CANONICAL.ATTESTER_CANNOT_RESOLVE,
  financial_gates_not_attested: CANONICAL.GATES_NOT_ATTESTED,
};

// ── §33/§34 binding violations (currently escape as 500) ───────────
// Sub-reason (after 'illegal_execution_binding:') → canonical 409.
// replay_not_verified is DELIBERATELY ABSENT: a frozen record that no
// longer reproduces itself is a P0 integrity alarm, not an operator-
// recoverable conflict — it stays a sanitized 500 (logged + captured
// server-side; nothing leaks in the body).
export const BINDING_TO_CANONICAL: Readonly<Record<string, CanonicalCode>> = {
  executor_cannot_approve: CANONICAL.EXECUTOR_IS_FINAL_APPROVER,
  approval_required: CANONICAL.APPROVAL_MISSING,
  preview_batch_mismatch: CANONICAL.CALC_HASH_MISMATCH,
  preview_reference_mismatch: CANONICAL.CALC_HASH_MISMATCH,
  preview_snapshot_mismatch: CANONICAL.CALC_HASH_MISMATCH,
  approval_batch_mismatch: CANONICAL.CALC_HASH_MISMATCH,
  approval_snapshot_mismatch: CANONICAL.CALC_HASH_MISMATCH,
};

export type MappedRefusal = {
  statusCode: number;
  error: string;
  message: string; // mirrors code
  code: string;
  reason: string;
};

// Machine codes are snake/dot/colon strings — never English prose.
// Guard/validator sentences ("Operation requires elevated
// permissions") must pass through untouched.
const MACHINE_CODE_RE = /^[a-z0-9_.:@><-]+$/;

export function isMachineCode(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && MACHINE_CODE_RE.test(s);
}

// Map a known legacy/canonical refusal string → the 409 contract, or
// null when the string is not governed by this contract.
export function mapRefusalMessage(message: unknown): MappedRefusal | null {
  if (!isMachineCode(message)) return null;
  const base = message.split(':')[0];
  const canonical = LEGACY_TO_CANONICAL[base];
  if (!canonical) return null;
  return {
    statusCode: 409,
    error: 'Conflict',
    message: canonical,
    code: canonical,
    reason: message,
  };
}

// Map an escaped IllegalExecutionBinding → the 409 contract, or null
// for the alarm-class sub-reason that must remain a sanitized 500.
export function mapBindingViolation(e: unknown): MappedRefusal | null {
  if (!(e instanceof IllegalExecutionBinding)) return null;
  const msg = String(e.message ?? '');
  const sub = msg.startsWith('illegal_execution_binding:')
    ? msg.slice('illegal_execution_binding:'.length)
    : msg;
  const canonical = BINDING_TO_CANONICAL[sub];
  if (!canonical) return null; // replay_not_verified and unknowns → 500
  return {
    statusCode: 409,
    error: 'Conflict',
    message: canonical,
    code: canonical,
    reason: msg,
  };
}
