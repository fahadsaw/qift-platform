# Settlement Engine — Permanent Implementation Rules

**Status: PERMANENT LAW.** Enacted by founder directive on 2026-07-21,
after Track C PR 1 (Settlement Engine Foundation, PR #82) was approved.
These rules bind every settlement PR, present and future. They are
implementation law subordinate to the constitutional canon
(`QIFT_SETTLEMENT_CONSTITUTION_v2.0.md`, `QIFT_FINANCIAL_PLATFORM_BLUEPRINT`
v1.0 + v1.0.1, `QIFT_REFERENCE_CONSTITUTION_v2.0.md`); where they
overlap they restate it, never replace it.

Every rule is enforced by permanent pinned tests in
`src/settlement/settlement-rules.spec.ts`. Weakening or deleting a pin
requires the same scrutiny as a constitutional amendment.

## Rule 1 — Calculations live only in the Settlement Engine

All settlement calculations remain inside the Settlement Engine
(`settlement-engine.service.ts` → `settlement-calculator.ts`).
Controllers, routes and endpoints **never** implement financial
calculations — they authorize, validate shape, delegate, and serialize.

- Restates SC §30.3 (the one-calculator law) and FC Rule 13.8.
- Pins: no `*.controller.ts` in `src/` may reference any financial
  primitive (`calculateSettlement`, `computeTax`,
  `computeMerchantGoodsTax`, `toMinor`, `fromMinor`, `vatOnMinor`,
  `extractNetMinor`, `allocateMoney`); `calculateSettlement` has exactly
  one non-spec importer — the engine.

## Rule 2 — No direct system time in the Settlement Engine

The engine never reads the system clock directly. Time enters only
through the injectable `SettlementClock`
(`src/settlement/settlement-clock.ts`, token `SETTLEMENT_CLOCK`);
`SystemSettlementClock` is the **single** sanctioned system-time site in
the settlement subsystem. Tests and the §34 replay harness inject fixed
clocks.

- Serves SC §34 (Deterministic Replay Law) and §30.6.
- Pins: PURE settlement sources (engine, calculator, states, module)
  contain zero Date construction, system-time, or randomness reads;
  settlement SERVICE sources (receipts, eligibility — SETTLE-1) may
  parse operator-supplied dates (evidence is data, not time) but are
  pinned to zero machine-clock reads and must inject the clock;
  `settlement-clock.ts` contains exactly one system-time read; a fixed
  clock makes `simulate` byte-identical across runs. Settlement
  services are additionally pinned to zero `settlementBatch` access —
  batch mutation is engine-only (Rule 3's perimeter).

## Rule 3 — SettlementBatch is immutable after assembly

Once assembled, a batch's frozen record — `settlementReference`,
`storeId`, `currency`, `windowType`, `grossAmount`, `netAmount`,
`composition`, `calculationSnapshot` — is never rewritten, and items are
never added, removed, or modified. The only mutable batch columns are
lifecycle: `status`, `failureEvidence`, `supersededById` (write-once).
**Any** change to composition or amounts is Supersede + a **new** batch
with a **new** QS (SC §2, §14.1, §34.2).

- Pins: a write-site census of the engine (`create` ×1, `update` ×4,
  `updateMany` ×1) with per-site key extraction proving only lifecycle
  keys are written; item membership writes exist only at assembly
  (guarded `state: 'eligible' AND batchId: null`) and supersession; the
  engine's method surface is a pinned list (a new mutator cannot appear
  unreviewed); a functional walk (fail → retry → fail → hold) proving
  frozen fields survive the whole lane, and that change requires
  Supersede → terminal → successor batch with a different QS.

## Rule 4 — The Settlement Statement is a constitutional output

Enacted by founder directive on 2026-07-22, after PR #84 approval.
The Settlement Statement (SC §15.1) is generated **only** by the pure
function in `src/settlement/settlement-statement.ts`, over frozen data
(QS, composition, calculation snapshot) plus supplied business facts
(issuance date, remittance evidence). **Replay must regenerate the
identical statement**: the generator never recomputes money (it renders
the frozen §4 lines verbatim), never reads a clock, DB, or randomness.
Format changes are a `statementVersion` bump; issued statements are
immutable.

- Serves SC §15.1 and extends §34 (Deterministic Replay Law) to the
  merchant-facing document.
- Pins: byte-identical regeneration (canonical JSON + hash equality);
  tampered frozen data flows through verbatim (proving no
  recomputation); purity import pin (exactly `crypto` + the calculator
  *type*); every date is a supplied input.

### Rule 4 addendum — Statement Hardening (2026-07-22, before SETTLE-3)

Founder-mandated hardening, all pinned:

1. **Canonical JSON is the source of truth.** Every issued statement
   stores its canonical JSON string (`canonicalJson` column) alongside
   the payload; every presentation layer — **PDF included — is
   presentation only**: it derives from the canonical string and adds
   no data. No print/render machinery may live in the settlement
   module (source-pinned).
2. **The hash derives from the canonical bytes only.**
   `hashCanonical(canonical)` is the single digest primitive;
   `statementHash ≡ sha256(canonicalJson(statement))` by construction.
3. **Digital signatures are supported structurally.** Signatures sign
   the canonical digest (`signableDigest ≡ statementHash`), never a
   payload object or rendering; envelopes accumulate append-only in
   `SettlementStatementSignature` (algorithm, Ch. 14-recorded keyId,
   signer, signedAt). No signer ships yet — the seam does.
4. **Replay is versioned.** `REPLAY_ENGINE_VERSION`
   (settlement-execution-binding.ts) names the verification semantics;
   every §34 run persists an append-only `SettlementReplayRecord`
   carrying it, and the replay response exposes it.
5. **Integrity before rendering.** Statement retrieval and replay
   verify `sha256(storedCanonical) = storedHash` AND
   `canonicalJson(payload) = storedCanonical` FIRST — a tampered
   record refuses retrieval (`statement_integrity_violation`) and
   replay surfaces `statementIntegrityVerified: false`, rendering only
   the regenerated-from-frozen statement as trustworthy.

## Rule 5 — Execution Preview before Execute, on the one calculator

An **Execution Preview must exist before Execute**, produced by
`buildExecutionPreview` (`src/settlement/settlement-execution-binding.ts`):
it renders the frozen snapshot (never recomputed values), carries the
snapshot's `calculationHash` as the binding token, §34-verifies by
recomputing the frozen composition through the **one calculator**
(`calculateSettlement`) and **comparing** — a mismatch is surfaced as
`replayVerified: false`, never masked, and blocks execution at the
Rule 6 gate. The preview's statement draft uses the Rule 4 generator.

- Serves SC §30.3 (one-calculator law) and §30.4 (mandatory
  pre-execution review).
- Pins: the calculator's only lawful production importers are the
  engine and the binding module (Rule 1 pin, updated); the binding
  module's imports are exactly the calculator + the statement module;
  tampered snapshots surface as unverified while frozen values still
  render.

## Rule 6 — Execution only from an approved preview; one frozen snapshot

**No execution may calculate anything independently.** The chain

```
Preview  ──►  Approval  ──►  Execute
```

binds to the **identical frozen calculation snapshot**, named by one
`calculationHash`. Every money-moving execution path MUST pass
`assertExecutionBinding(frozen, preview, approvals, executorUserId)`,
which refuses: a preview of another batch, a preview or approval whose
hash differs from the frozen snapshot's, an unverified §34 replay,
missing approvals, and an executor who appears among the approvers
(SC §33 separation, strict form — no emergency collapses it). SETTLE-2's
execute service consumes this gate and uses only the frozen snapshot
thereafter.

- Serves SC §31–§33 (approvals, thresholds, approval/execution
  separation) and §34.
- Pins: the full refusal matrix (each violation by name); the lawful
  chain passes; hash canonicalization (key-order independence, one-
  halala sensitivity); preview/approval/statement all carry the same
  token.

## Financial invariants (RC v3.0 — 2026-07-22, before SETTLE-3b)

Founder-mandated, recorded in `QIFT_REFERENCE_CONSTITUTION_v3.0.md`
(the QN-activation amendment), pinned in
`settlement-invariants.spec.ts`:

1. **Credit Notes are first-class financial documents.** Every credit
   note has: a canonical **Reference** (QN — random operational,
   minted once at issuance, immutable); a **Canonical JSON**
   representation (the source of truth, stored); a **Hash** derived
   from the canonical bytes only (`creditNoteHash ≡
   hashCanonical(creditNoteCanonical)`); **Replay** (same frozen facts
   → byte-identical document; `replayCreditNote` verifies and audits);
   an **Audit** trail (`finance.credit_note.issued`); its **Invoice
   relationship** (type + id + the merchant's SUPPLIED legal number);
   and its **Statement relationship** (`statementSettlementId`,
   write-once when the enumerating settlement statement exists —
   SETTLE-3b populates it; the null is part of the hashed document, so
   attachment is a new document version, never a silent rewrite).
2. **Merchant Receivables are lifecycle entities.** Minimum states —
   `open / partially_recovered / recovered / written_off / disputed` —
   with transitions only through
   `settlement-receivable-states.ts` (recovered and written_off are
   terminal; write-off is §32 L3 + advisor note when its surface
   ships). `amountRecovered` tracks §7.4 offset progress.
3. **Reserve ≠ Receivable — never merged.** A reserve is withheld
   remittance (client money, §7.3); a receivable is money the merchant
   owes Qift. The §7.4 recovery order (offset first, then reserve
   draw) is an interaction, not a unification. Pinned: no reserve
   state or field on the receivable; the future reserve model must
   carry no receivable fields (extend the pin symmetrically when it
   lands).

## SETTLE-3b note — §7.4 recovery is part of the §34 record

The batch's `recoveryAllocation` (per-receivable offsets behind the §4
`receivableRecovery` line) is FROZEN at assembly and is a **calculation
input**: §34 replay and the Rule 5 preview recompute the one calculator
WITH it, never from live receivable rows. Staging is guarded
(state + unstaged + exact `amountRecovered` at plan — the amount-pin
discipline extended to receivables); supersession releases stages;
consumption happens inside `markSettled`'s atomicity with
per-`(receivableId, settlementId)` recovery postings; the enumerating
statement triggers the RC v3.0 credit-note statement attachment (a new
document version, write-once, audited).

## SETTLE-3c-1 note — the Qift fee-leg credit note (RC v4.0)

Qift is the LEGAL ISSUER of its own service-fee credit notes: the QD
sequential series (RC v4.0, NumberSequence-allocated, gap-free) is
Qift's alone — a fee-leg note refuses any merchant number or on-behalf
evidence, and a goods note can never carry QD (series separation,
pinned both directions). The FROZEN Qift invoice is the only source of
truth (amounts, VAT proportion, tax-rule version, party snapshots —
never the live engines). Pre-payment credits reduce the unpaid
receivable (refund.approved compensations; the receipts service
computes coverage against the EFFECTIVE total); post-payment refunds
return cash from OPERATING with a compensating revenue reversal + a
frozen-proportion VAT reversal. Agent-model law (pinned): the fee leg
never touches MerchantPayable, MerchantReceivable, settlement items,
or reserves. Document format v3 (fee legal freeze in the hashed
document); version 1 append-only as everywhere.

## Refund-integrity note — the three boundaries (Track C corrective)

**Boundary 1 — document ≠ cash.** A credit note is a legal DOCUMENT;
a refund is a CASH event. No cash posting exists without external
evidence: bank/PSP reference, value date (`refundedAt`), the
bank-confirmed amount, the executor's identity, and the evidence
triple `(invoiceType, invoiceId, evidenceRef)` as the §18.1 replay
identity. Pre-payment credits (`invoice_reduced`) are the only
evidence-free lane and they move NO cash — they reduce the unpaid
receivable.

**Boundary 2 — payment status ≠ balance closure.** `paymentStatus`
(unpaid / partially_paid / paid) answers "did cash arrive?";
`balanceStatus` (open / partially_credited / closed_by_payment /
closed_by_credit) answers "is anything still owed?". A fully-credited
zero-receipt invoice closes `closed_by_credit` with status `issued`
and `paidAt` NULL — it is never "paid". Coverage, recognition, and
receipts compute against the EFFECTIVE total (total − fee credits);
aging (the DSO/collection surface) ages only effective open balances,
so credit-only closures never appear in collection metrics. Reading
note for auditors: when a credit lands AFTER a partial payment and
extinguishes the remaining balance, the invoice flips paid with
`paidAt` = the LAST receipt's value date — the payment that
ultimately covered it — which can predate the credit that completed
coverage.

**Boundary 3 — refund maker–checker.** Cash leaves only through
request → INDEPENDENT approval → evidenced execution
(`RefundRequest`: requested → approved → executed, or cancelled).
The approval binds an immutable canonical snapshot (invoice + legal
number, amount, VAT, reason, recipient, method → `snapshotHash`,
canonical-JSON/sha256); execution re-verifies the hash and refuses
drift (`refund_snapshot_tampered`) and any confirmed-amount mismatch.
Identity law: requester ≠ approver (`refund_self_approval_rejected`),
final approver ≠ executor (`refund_approver_cannot_execute`); the
requester MAY execute (preparer-execution, the §33.2 shape). Evidence
already bound to another request refuses
(`refund_evidence_already_used`); a crash between posting and binding
rolls forward on retry without double-posting. The single-actor
`POST finance/refunds` route is REMOVED; `recordRefund` is an
internal engine primitive reachable only via `executeRefund`.
Thresholds: RESERVED — the §32 authorization matrix carries no refund
row; adding refund thresholds is a Settlement Constitution amendment,
not a code change.

## §26 note — Zero-Net Statement-Only Close (Lane 2 PR 2)

A batch whose FROZEN net is EXACTLY zero (integer minor units in the
batch currency's exponent; ±1 minor is not zero) closes through a
Settlement Statement with **no bank transfer**: no SettlementRemittance,
no bank reference, no `merchant.remittance.paid`, no cash-movement
claim of any kind. The close travels the SAME chain as bank execution
— recorded preview → approvals bound to the frozen calculationHash →
the RULE 6 binding gate (executor ∉ approvers; the final approver
never closes) — and its terminal act (`markSettledZeroNet`) settles
batch + items, consumes the frozen recovery allocation, posts the
zero-amount `settlement.completed` marker, and stamps
`closureType='zero_net_no_transfer'` + `closedAt` atomically. The
statement (format v2) carries the closure block: opening position from
the frozen lines, `ZERO_NET_NO_TRANSFER`, and the explicit no-transfer
text — it is the sole legal instrument of closure; replay regenerates
it byte-identically from stored facts.

**Authorization level (§32.1, explained):** the basis is the
EXTINGUISHED GROSS (= the recovery consumed), never the zero cash
figure — extinguishing a large position can never ride a lower band
than remitting it. Zero-net closes also feed the §32.3 day aggregate
at their gross (closedAt basis), so fragmentation across
statement-only closes cannot lower the band.

**Recovery postings under §26 carry no cash claim:** the physical
safeguarding→operating sweep has NOT happened at close — the postings
carry `internalTransferDue: true` instead of accountFrom/To, and the
treasury reconciliation classifies them as enumerated NON-CASH
closures (internal-transfer-due), never mismatches. Recording the
physical sweep is a future treasury action; until recorded, a
post-sweep bank attestation will honestly mismatch — deliberate.

**`closedAt` is a RECORDING instant in BOTH lanes** (the clock at the
terminal transition), never the bank value date — the remitted lane's
day aggregate still reads `executedAt`/`createdAt` from the remittance
row, and the zero-net aggregate window depends on `closedAt` staying
recording-basis; "fixing" it to `executedAt` would silently change
§32.3 semantics. **Remitted lane unchanged:** `markSettled` now stamps
`closureType='remitted'` + `closedAt` with its terminal transition;
v1 statements' bytes are unchanged. A zero-net-closed batch refuses
bank execution (`settlement_closed_zero_net`) and supersession
(settled is terminal); a remitted batch refuses the zero-net lane
(`settlement_already_remitted`). Assembly now mints zero-net batches
(the §26 close is their lawful exit); negative nets remain refused
(`settlement_negative_net_deferred`) and are structurally unreachable
through the gross-capped §7.4 planner.

## Amending these rules

A change to any rule (or its pins) must name the rule, cite the
constitutional sections affected, and land as its own reviewed PR that
updates this document and `settlement-rules.spec.ts` together.
