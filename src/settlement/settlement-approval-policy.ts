// Approval policy (SC v2.0 §31–§32) — Track C PR 3 (SETTLE-2).
//
// STRUCTURE IS CANON; VALUES ARE POLICY (§32.1). This module encodes
// the batch-execution ROW of the §32 matrix:
//
//   Batch execution:  ≤ T1 → L2   ·   T1..T2 → L2   ·   > T2 → L3
//
// L2 = maker–checker: ONE approver, distinct from the proposer
//      (§31.1; the batch's assembledBy). The proposer MAY execute
//      (§33.2 preparer-execution is lawful).
// L3 = dual approval: TWO distinct approvers, one holding the
//      senior-finance designation (Ch. 14-recorded; pilot carries it
//      as deployment config). Until a third seat exists, L3 cannot
//      execute — stated honestly, never bypassed (§31.1).
//
// Anti-fragmentation (§32.3): the band evaluates against BOTH the
// single batch net AND the rolling aggregate per (merchant, currency,
// day) — splitting to duck a band applies the aggregate's band to
// every fragment.
//
// The values below are the §32.1 OPENING policy (v1.0.1-era), recorded
// with a version string; changing them is a Ch. 14 maker–checker
// policy change (new version), never an edit of history.
//
// Pure module (GOVERNED_PURE): no clock, no I/O — callers supply
// amounts; TTL is a constant the service applies against its
// injectable clock.

export const APPROVAL_POLICY = {
  version: 'sc-32.1-opening@pilot-1',
  currency: 'SAR',
  t1Minor: 500_000, // SAR 5,000.00
  t2Minor: 5_000_000, // SAR 50,000.00
  // §31.3 initial policy: unexecuted approvals lapse after 72 hours.
  // The same TTL governs preview-act freshness (RULE 5/§30.6).
  approvalTtlHours: 72,
  // Anti-backdating window (§32.3 defense): the supplied bank value
  // date must sit within [now − 7d, now + 24h]. A movement outside
  // the window is recorded via the incident/repair lane, never as a
  // routine execution that ducks the day aggregate.
  executedAtMaxAgeHours: 168,
  executedAtMaxSkewHours: 24,
} as const;

export type ExecutionBand = 'le_t1' | 't1_t2' | 'gt_t2';

export function executionBand(amountMinor: number): ExecutionBand {
  if (amountMinor <= APPROVAL_POLICY.t1Minor) return 'le_t1';
  if (amountMinor <= APPROVAL_POLICY.t2Minor) return 't1_t2';
  return 'gt_t2';
}

export type ExecutionApprovalRequirement = {
  level: 2 | 3;
  approvalsNeeded: 1 | 2;
  seniorRequired: boolean;
  band: ExecutionBand;
  aggregateBand: ExecutionBand;
  policyVersion: string;
};

// The batch-execution row, with §32.3 anti-fragmentation: the band
// evaluates against BOTH the single amount AND the day's rolling
// aggregate INCLUDING this action (otherMinorToday + this net) — the
// wider band governs every fragment. §32.4: risk escalation may only
// RAISE — the pilot risk posture is static (§29.7), so no lowering
// path exists.
export function requiredExecutionApproval(
  netMinor: number,
  otherMinorToday: number,
): ExecutionApprovalRequirement {
  const band = executionBand(netMinor);
  const aggregateBand = executionBand(netMinor + otherMinorToday);
  const effective: ExecutionBand =
    aggregateBand === 'gt_t2' || band === 'gt_t2'
      ? 'gt_t2'
      : aggregateBand === 't1_t2' || band === 't1_t2'
        ? 't1_t2'
        : 'le_t1';
  const level = effective === 'gt_t2' ? 3 : 2;
  return {
    level,
    approvalsNeeded: level === 3 ? 2 : 1,
    seniorRequired: level === 3,
    band,
    aggregateBand: effective,
    policyVersion: APPROVAL_POLICY.version,
  };
}
