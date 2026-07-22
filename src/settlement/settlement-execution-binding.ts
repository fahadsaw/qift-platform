// Execution binding law (permanent RULES 5 + 6).
//
// Enacted by founder directive after PR #84 approval:
//
//   RULE 5 — an Execution Preview must exist before Execute, and the
//            preview uses the SAME calculator as execution (§30.3 —
//            this module is the only lawful second importer of
//            calculateSettlement, and it uses it exclusively to
//            RECOMPUTE-AND-COMPARE, never to produce output).
//   RULE 6 — execution is allowed ONLY from an approved preview.
//            No execution may calculate anything independently.
//            Preview → Approval → Execute all bind to the IDENTICAL
//            frozen calculation snapshot, named by one hash.
//
// The chain, structurally:
//
//   buildExecutionPreview(frozen)   — renders the FROZEN snapshot
//        │                            (statement draft, net, hash)
//        │                            + §34 verify: recompute the
//        │                            frozen composition through the
//        │                            ONE calculator and COMPARE.
//        ▼
//   ExecutionApproval               — quotes the preview's
//        │                            calculationHash (an approval of
//        │                            THAT money, not "a" batch).
//        ▼
//   assertExecutionBinding(...)     — the execute path MUST pass this
//                                     gate: frozen hash ≡ preview hash
//                                     ≡ every approval's hash, replay
//                                     verified, executor ∉ approvers
//                                     (§33 separation, strict form).
//
// Pure: no I/O, no clock, no randomness. SETTLE-2's execute service
// calls this; it never re-derives amounts (pinned).

import { calculateSettlement } from './settlement-calculator';
import {
  calculationHash,
  canonicalJson,
  generateSettlementStatement,
  type FrozenBatchRecord,
  type SettlementStatement,
} from './settlement-statement';

// STATEMENT HARDENING (req. 4): the replay harness carries a VERSION.
// Every §34 replay run stores and exposes the engine version that
// produced its verdict, so a verification recorded years ago stays
// interpretable when the harness evolves. Semantics of v1:
//   calculation — recompute the frozen composition through the ONE
//   calculator and compare canonical bytes to the frozen snapshot;
//   statement — verify stored integrity (canonical bytes → hash),
//   then regenerate from frozen data + stored facts and compare
//   hashes. A change to EITHER semantic is a new version, recorded
//   here with its predecessor's meaning preserved in history.
export const REPLAY_ENGINE_VERSION = 'settle2-replay@v1';

export type ExecutionPreview = {
  preview: true;
  settlementId: string;
  settlementReference: string;
  storeId: string;
  currency: string;
  netAmount: number; // from the FROZEN snapshot, verbatim
  itemCount: number;
  // The RULE 6 binding token: names the exact frozen calculation.
  calculationHash: string;
  // §34 verification: the frozen composition, recomputed through the
  // ONE calculator, reproduced the frozen snapshot exactly. FALSE is
  // a P0 signal — assertExecutionBinding refuses it.
  replayVerified: boolean;
  // The statement exactly as execution would issue it (draft carries
  // the preview's asOf as issuedAt; the issued statement substitutes
  // the real issuance fact — same generator, RULE 4).
  statementDraft: SettlementStatement;
  asOf: string; // supplied business fact, never a machine clock
};

export type ExecutionApproval = {
  settlementId: string;
  settlementReference: string;
  calculationHash: string; // must quote the preview's token
  approvedBy: string;
  level: number; // §31 ladder (1..4)
  approvedAt: string; // ISO, recorded fact
};

export class IllegalExecutionBinding extends Error {
  constructor(code: string) {
    super(`illegal_execution_binding:${code}`);
  }
}

export function buildExecutionPreview(
  frozen: FrozenBatchRecord,
  opts: { asOf: string },
): ExecutionPreview {
  // §34 verify — recompute-and-COMPARE. The recomputed value is never
  // used as output; the frozen snapshot remains the only truth.
  const recomputed = calculateSettlement(
    frozen.composition.map((c) => ({
      itemId: c.itemId,
      occurrenceType: c.occurrenceType,
      occurrenceId: c.occurrenceId,
      amount: c.amount,
      currency: c.currency,
    })),
    {
      // §7.4/§34: the frozen allocation IS a calculation input — the
      // replay recomputes the recovery line from it, never from live
      // receivable rows.
      receivableRecovery: (frozen.recoveryAllocation ?? []).reduce(
        (t, r) => t + r.amount,
        0,
      ),
    },
  );
  const replayVerified =
    canonicalJson(recomputed) === canonicalJson(frozen.calculationSnapshot);
  return {
    preview: true,
    settlementId: frozen.settlementId,
    settlementReference: frozen.settlementReference,
    storeId: frozen.storeId,
    currency: frozen.currency,
    netAmount: frozen.calculationSnapshot.netAmount,
    itemCount: frozen.calculationSnapshot.itemCount,
    calculationHash: calculationHash(frozen.calculationSnapshot),
    replayVerified,
    statementDraft: generateSettlementStatement(frozen, {
      issuedAt: opts.asOf,
      remittance: null,
    }),
    asOf: opts.asOf,
  };
}

// The execute gate. Every money-moving execution path MUST pass here
// first — and may then use ONLY the frozen snapshot the hash names.
export function assertExecutionBinding(
  frozen: FrozenBatchRecord,
  preview: Pick<
    ExecutionPreview,
    'settlementId' | 'settlementReference' | 'calculationHash' | 'replayVerified'
  >,
  approvals: readonly ExecutionApproval[],
  executorUserId: string,
): void {
  const frozenHash = calculationHash(frozen.calculationSnapshot);
  if (preview.settlementId !== frozen.settlementId) {
    throw new IllegalExecutionBinding('preview_batch_mismatch');
  }
  if (preview.settlementReference !== frozen.settlementReference) {
    throw new IllegalExecutionBinding('preview_reference_mismatch');
  }
  if (preview.calculationHash !== frozenHash) {
    throw new IllegalExecutionBinding('preview_snapshot_mismatch');
  }
  if (!preview.replayVerified) {
    // §34: a frozen record that no longer reproduces itself is a P0 —
    // nothing executes off it.
    throw new IllegalExecutionBinding('replay_not_verified');
  }
  if (approvals.length === 0) {
    throw new IllegalExecutionBinding('approval_required');
  }
  for (const approval of approvals) {
    if (
      approval.settlementId !== frozen.settlementId ||
      approval.settlementReference !== frozen.settlementReference
    ) {
      throw new IllegalExecutionBinding('approval_batch_mismatch');
    }
    if (approval.calculationHash !== frozenHash) {
      throw new IllegalExecutionBinding('approval_snapshot_mismatch');
    }
    if (approval.approvedBy === executorUserId) {
      // §33 separation, strict form: the executor appears among NO
      // approvers (a fortiori not the final one). No emergency
      // collapses it.
      throw new IllegalExecutionBinding('executor_cannot_approve');
    }
  }
}
