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

## Amending these rules

A change to any rule (or its pins) must name the rule, cite the
constitutional sections affected, and land as its own reviewed PR that
updates this document and `settlement-rules.spec.ts` together.
