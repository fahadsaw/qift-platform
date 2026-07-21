// §31–§32 approval policy — pins (Track C PR 3).
//
// Structure is canon; values are policy (§32.1). These pins hold the
// batch-execution row of the matrix and the §32.3 anti-fragmentation
// law to the OPENING policy version — changing a value is a Ch. 14
// policy change that must arrive with a NEW version string.

import {
  APPROVAL_POLICY,
  executionBand,
  requiredExecutionApproval,
} from './settlement-approval-policy';

describe('approval policy (§31–§32)', () => {
  it('pins the opening policy values and version', () => {
    expect(APPROVAL_POLICY).toEqual({
      version: 'sc-32.1-opening@pilot-1',
      currency: 'SAR',
      t1Minor: 500_000, // SAR 5,000
      t2Minor: 5_000_000, // SAR 50,000
      approvalTtlHours: 72, // §31.3 initial policy (also preview-act freshness)
      executedAtMaxAgeHours: 168, // §32.3 anti-backdating window
      executedAtMaxSkewHours: 24,
    });
  });

  it('band boundaries are inclusive at the threshold (≤ T1, ≤ T2)', () => {
    expect(executionBand(500_000)).toBe('le_t1'); // exactly T1
    expect(executionBand(500_001)).toBe('t1_t2');
    expect(executionBand(5_000_000)).toBe('t1_t2'); // exactly T2
    expect(executionBand(5_000_001)).toBe('gt_t2');
  });

  it('batch execution is NEVER single-operator: L2 through T2, L3 above (§32 matrix row)', () => {
    expect(requiredExecutionApproval(100_000, 0)).toMatchObject({
      level: 2,
      approvalsNeeded: 1,
      seniorRequired: false,
    });
    expect(requiredExecutionApproval(3_000_000, 0)).toMatchObject({
      level: 2,
      approvalsNeeded: 1,
    });
    expect(requiredExecutionApproval(6_000_000, 0)).toMatchObject({
      level: 3,
      approvalsNeeded: 2,
      seniorRequired: true,
    });
  });

  it('§32.3 anti-fragmentation: the day aggregate INCLUDES this action and governs every fragment', () => {
    // A 30k batch alone: L2. The same 30k with 25k already remitted
    // today (aggregate 55k > T2): L3 — splitting never ducks the band.
    expect(requiredExecutionApproval(3_000_000, 0)).toMatchObject({
      level: 2,
    });
    expect(requiredExecutionApproval(3_000_000, 2_500_000)).toMatchObject({
      level: 3,
      seniorRequired: true,
    });
    // Two 30k fragments: the second aggregates to 60k → L3. Structuring
    // around the matrix never works.
    expect(requiredExecutionApproval(3_000_000, 3_000_000).level).toBe(3);
    // Escalation is one-way (§32.4): a small aggregate never lowers
    // the single-amount band.
    expect(requiredExecutionApproval(6_000_000, 0).level).toBe(3);
  });

  it('records the policy version on every requirement', () => {
    expect(requiredExecutionApproval(1, 0).policyVersion).toBe(
      APPROVAL_POLICY.version,
    );
  });
});
