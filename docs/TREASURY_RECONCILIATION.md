# Three-way Treasury Reconciliation (Lane 2 PR 1)

**Constitutional basis:** Settlement Constitution v2.0 §10.3 (daily
three-way treasury reconciliation — required from the first collected
riyal), §13.3 (account movement law), §1 (every riyal enumerable),
§27 (off-book wires forbidden — this surface is how they are
DETECTED), §24 (forward-only corrections); Financial Constitution
v1.0 Ch. 17.2, Ch. 5 (reconciliation surfaces). Closes Readiness
Audit v1.0 gap G1.

## The three legs

1. **Bank** — the attested safeguarding balance. NEVER invented:
   entered only from bank evidence (`TreasuryAttestation`, append-only,
   `manual_attestation` today, `statement_import` seam for later).
   No attestation for the day → the run is honestly `pending` with a
   null bank leg.
2. **Ledger cash view** — Σ safeguarding-account cash movements with
   bank value date ≤ asOf: goods receipts in
   (`invoice.payment.received`, metadata.account=safeguarding);
   remittances (`merchant.remittance.paid`), safeguarding goods
   refunds (`refund.paid`, account=safeguarding), and §13.3(a)
   recovery draws (`merchant.receivable.recovered`) out. Value dates
   come from the EVIDENCE rows the postings anchor (receipt
   `receivedAt`, remittance `executedAt`, refund `refundedAt`) — never
   the machine clock, never the recording timestamp.
3. **Obligations view** — what the balance must cover: corporate
   payable accruals in (`merchant.payable.accrued` anchored on
   receipts), the same remittances/refunds/recoveries out. Legs 2 and
   3 are equal BY CONSTRUCTION when every posting family is symmetric
   — a non-zero delta between them is a posting asymmetry, broken
   down per event type.

**Scope** is versioned: `corporate_manual_rail@pilot-1`. Consumer-lane
rows (MockGateway — no real cash) and operating-account cash are
enumerated as EXCLUDED classes with counts and amounts — nothing is
silently dropped.

## Status law

`pending` (computed without bank evidence) · `matched` · `mismatched`
→ `investigated` → `resolved`. Records are APPEND-ONLY immutable
snapshots (re-running a day creates a new record); transitions are
guarded `updateMany({id, status})` writes, notes mandatory, all
audited (`finance.treasury.*`). **Resolution is documentation** —
notes + evidence reference. Corrections travel the constitutional
lanes (refunds, receivables, compensating entries — SC §24); this
surface never moves money.

## Determinism + integrity

Every run produces a canonical-JSON snapshot (movements
deterministically ordered) and `snapshotHash = sha256(canonical)` —
same law as Settlement Statements. Retrieval verifies
`sha256(storedCanonical) == storedHash` before rendering
(`treasury_reconciliation_integrity_violation`). Snapshot format
version `treasury-3way@v1`; a format change bumps the version, never
edits an issued record. Snapshots are PII-free: references, ids, bank
references only.

## Differences are enumerated, never netted

- `bank_vs_ledger_cash` — the unexplained bank delta (off-book wire
  detection, §27).
- `cash_vs_obligations` — internal posting asymmetry, with a
  per-event-type minor-unit breakdown.
- `unresolved_evidence` — a ledger row whose anchor resolves to no
  evidence row (one enumerated exception per row; the movement is
  EXCLUDED from balances — no guessing).
- `negative_bank_balance` — client money must never be overdrawn.
- Timing items (value date after asOf) are set aside and listed, not
  netted.

## Boundaries (founder mandate, pinned in tests)

- READ-ONLY over money: the service writes only its two treasury
  tables + audit rows — census-pinned (no `ledger.record`, no money
  table mutations).
- Not gated on `QIFT_FINANCIAL_GATES_ATTESTED`: reconciliation is
  measurement, and measurement must be provable BEFORE the first
  riyal (Evidence Checklist item D3). The gate blocks money movement;
  this surface moves none.
- Permission: every route behind `finance.reconcile`.

## Operating conventions (review findings 3 + 4)

- **The attestation↔run instant convention:** attest and run at the
  SAME end-of-day instant (e.g. `2026-07-21T23:59:59.000Z`).
  Attestation auto-selection and the explicit-id check require exact
  timestamp equality, and the value-date cut is `≤ asOf` on that
  instant — attesting midnight while running end-of-day (or vice
  versa) produces a spurious `pending` or misfiled timing items. Day
  granularity normalization is a possible follow-up; until then the
  convention is law.
- **'pending' means only "awaiting the bank leg."** Bank-independent
  defects (posting asymmetry, unresolved evidence) classify the run
  `mismatched` even with no attestation, so a detected defect always
  enters the investigated → resolved lifecycle.
- **Staging note:** pre-SETTLE-3b seeded refund rows that carry
  `account: 'safeguarding'` with a `receivable_accrued` interaction
  will (correctly) trip `cash_vs_obligations` on their first run —
  expected on historical seeds, impossible in production (gates were
  closed; zero rows).

## §26 non-cash closures (snapshot v2 — Lane 2 PR 2)

Zero-net statement-only closes extinguish obligations WITHOUT cash:
their recovery postings (metadata `closureType='zero_net_no_transfer'`)
classify as an enumerated NON-CASH class — obligations leg only, value
date = the recorded close instant, `internalTransferDueMinor` carried
as its own leg figure. The cash-vs-obligations delta is adjusted by
exactly that enumerated amount (raw and adjusted both in the
snapshot), so a §26 close is `matched`, never a mismatch and never an
unresolved-evidence exception. The safeguarding account lawfully holds
the extinguished amount pending the PHYSICAL internal sweep — a
future treasury action; once swept, the post-sweep attestation will
honestly mismatch until sweep-recording ships (deliberate, recorded).
**Ops rule for that day:** the mismatch must still be walked through
investigated → resolved with the sweep's bank advice as evidence —
"expected: internal sweep not yet recordable" is the resolution NOTE,
never a reason to skip the lifecycle. Operators who learn to wave
mismatches through defeat the entire surface.

## Deferred (recorded, deliberate)

- **Reconciliation-failure batch-blocking** (SC §10.3 "failure blocks
  batches") and **health alerts** — arrive with Lane 2 PR 3
  (reconciliation-zero health alerts). Until then a `mismatched` day
  is surfaced by this API and the audit trail, not enforced against
  assembly.
- `statement_import` source — the import seam exists as a source
  value; a real bank-statement importer is a later PR.
- Multi-account (operating-account reconciliation) — safeguarding
  first; the model carries `accountType` for the extension.

## Migration impact + rollback

Migration `20260723200000_treasury_reconciliation`: ADDITIVE ONLY —
two new tables (`TreasuryAttestation`, `TreasuryReconciliation`), no
existing table touched, no DROP. Rollback = revert the code; the
tables remain, empty and inert (forward-only financial schema,
SC §24.1).
