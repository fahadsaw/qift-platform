// Merchant Receivable lifecycle law (RC v3.0 invariant, founder
// directive at PR #88 approval).
//
// A merchant receivable (money the MERCHANT owes Qift after a
// post-settlement clawback — SC §2 Reversed, §8.4) is a LIFECYCLE
// ENTITY. Minimum states, verbatim from the directive:
//
//   open                — accrued, nothing recovered yet
//   partially_recovered — some money offset (§7.4), balance remains
//   recovered           — fully extinguished (terminal)
//   written_off         — recovery abandoned (terminal; §32 matrix:
//                         L3 ALWAYS + advisor note — the write-off
//                         SURFACE ships with its approval lane, this
//                         law binds it now)
//   disputed            — frozen by a settlement dispute (§16); only
//                         the disputed amount freezes, resolution
//                         returns it to its recovery lane
//
// SEPARATION LAW (verbatim): Reserve and Receivable remain SEPARATE
// financial concepts — NEVER merged. A reserve is WITHHELD REMITTANCE
// (still client money in safeguarding, §7.3); a receivable is money
// the merchant OWES Qift. The §7.4 recovery ORDER (offset first, then
// reserve draw) is an interaction between the two concepts, never a
// unification. This module carries no reserve semantics — pinned.

export const RECEIVABLE_STATES = [
  'open',
  'partially_recovered',
  'recovered',
  'written_off',
  'disputed',
] as const;
export type ReceivableState = (typeof RECEIVABLE_STATES)[number];

const RECEIVABLE_TRANSITIONS: Record<
  ReceivableState,
  readonly ReceivableState[]
> = {
  open: ['partially_recovered', 'recovered', 'written_off', 'disputed'],
  partially_recovered: ['recovered', 'written_off', 'disputed'],
  recovered: [],
  written_off: [],
  disputed: ['open', 'partially_recovered', 'written_off'],
};

export class IllegalReceivableTransition extends Error {
  constructor(from: string, to: string) {
    super(`illegal_receivable_transition:${from}->${to}`);
  }
}

export function assertReceivableTransition(
  from: ReceivableState,
  to: ReceivableState,
): void {
  if (!RECEIVABLE_TRANSITIONS[from]?.includes(to)) {
    throw new IllegalReceivableTransition(from, to);
  }
}
