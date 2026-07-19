# Track B Execution Charter — Financial Administration Platform

*Produced from the constitutional alignment review of 2026-07-20
(five governing documents read in order: Master Blueprint, Financial
Constitution, Reference Constitution, Operations Manual, Core
Invariants). This charter is a working document, not a constitution.*

## Constitutional basis
Financial Constitution Ch. 21 pre-authorizes every schema change in
this track ("MerchantInvoice: KEEP; MODIFY: paidAt/dueDate/export
columns"; "Store VAT facts: KEEP; MODIFY: ops admin toggle"); FIN-5
names the reconciliation exposure and VAT toggle as scheduled work.
**No architectural change in Track B requires a constitutional
amendment, and none is made.**

## Scope
- **B1 / PE-13** — MerchantInvoice mirror columns (dueDate, paidAt,
  externalAccounting*/accountingExport*). Columns only; NO writers.
- **B2 / PE-11** — Ops reconciliation endpoint: findMissing (read-only)
  + repair (append-only, idempotent), finance-gated, audited,
  reference-carrying responses.
- **B3 / PE-12** — VAT-facts toggle with server-enforced maker–checker
  (proposer ≠ approver), mandatory verification evidence, future
  issuances only. Both repos.
- **B4 / PE-15** — Org-console billing view: read-only over the three
  existing org routes; QB/QC/merchant number + provenance; honest
  null/missing/configured:false states; zero client-side money math.
- **B5 / PE-17** — Hygiene: blocking migration-timestamp-uniqueness CI
  lint; stale schema header comment; status updates in mutable docs.

## Out of scope (constitutionally rejected if attempted)
markPaid/receipts/settlement logic or aging (SETTLE-1, Track C, Ch.
6.2); InvoiceExport table or connector code (Stage 5); QS issuance or
touching its refusal test; FeeEngine/discounts/PSP; merchant self-serve
VAT editing (§18.6); pay-now/dunning/any billing write surface (§33.3);
auto-repair cron ("learn before you automate"); edits to any frozen
constitution.

## Binding constraints (short list)
Ledger append-only — repair appends via existing deterministic keys,
never creates invoices, never touches NumberSequence or reference
columns. VAT-fact changes affect FUTURE issuances only (snapshot law).
Two-person rule server-side + evidence note + before/after audit
(Financial Constitution Ch. 14.1/14.2). One @RequireOpsPermission per
new route on existing guard infra; audit carries references + business
identity, never personal PII; Store.vatNumber is PII (console-only).
Billing view employer-blind (no QG, counts only); references rendered
monospace/LTR/select-all; no synthesized placeholder references. MFA
step-up for financial flips is a KNOWN GAP (Core Invariants §17.9) —
recorded, not faked.

## Founder Action Pack dependencies
None block B1–B5. The pack's merchant-VAT-facts item is *executed
through* B3 once merchants confirm in writing (evidence note = that
confirmation). Entity/VAT/ZATCA gate blocks real invoicing, not this
code. The two-person rule needs a second admin seat (pack item).

## PR order
B1 → B2 → B3 → B4 → B5. Every PR body carries: constitutional
documents implemented, invariants relied on, migration impact,
rollback plan, CI proof, verification evidence.

## Success criteria
All five merged green on both repos; P1 exit gate satisfied (SETTLE-1
may begin); reconciliation runnable from a screen; VAT facts changeable
only by two identities with evidence; company admins self-serve their
invoices + summary; migration lint blocking; suites green throughout;
new capabilities registered 🔶 VALIDATE (Pilot #1).

## Rollback strategy
Financial schema is FORWARD-ONLY (Core Invariants #22): B1/B3 rollback
= revert application code — nullable columns/tables remain, unread.
B2/B3 endpoints: revert the PR (ledger untouched; repair only ever
appended idempotently). B4/B5: plain reverts. Read-only prod
pre-checks before every schema PR.

## Pilot #1 impact
B4 removes billing-question round-trips (24h SLA protection); B3 makes
pilot merchants' VAT facts settable compliantly before their first
invoice; B1/B2 guarantee pilot invoices reconcile to the ledger; B5
protects the migration chain. No pilot-facing behaviour changes beyond
new read surfaces.
