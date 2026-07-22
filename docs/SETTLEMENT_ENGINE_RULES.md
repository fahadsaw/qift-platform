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

## Amending these rules

A change to any rule (or its pins) must name the rule, cite the
constitutional sections affected, and land as its own reviewed PR that
updates this document and `settlement-rules.spec.ts` together.
