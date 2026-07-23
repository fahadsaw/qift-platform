# Finance Ops Error Contract (`finops-errors@v1`)

Founder closure task, 2026-07-23. Defines the **stable HTTP contract** for every
refusal the Finance Ops Console consumes. Presentation layer only: no financial
calculation, settlement state machine, approval rule, or schema changed — refusal
**conditions** live in the services exactly as before; this contract shapes only
the HTTP **response** of refusals that already happened.

Implementation: `src/financial/finance-ops-error-contract.ts` (mapping tables) +
`finance-ops-error-contract.filter.ts` (boundary filter, registered on
`AdminController` only). Pins: `finance-ops-error-contract.spec.ts` and the
error-contract block in `settlement-execution.spec.ts`.

## Status taxonomy

| Class | Status |
|---|---|
| Stale preview / calculation-hash mismatch / changed-or-closed batch | **409** |
| Separation-of-duties violations (executor∈approvers, proposer approves, attester resolves) | **409** |
| Missing permission (ops guard) | **403** (prose body, unchanged) |
| Malformed input | **400** (service `BadRequestException`, unchanged) |
| Tenant-scoped entity not found | **404** (`invoice_not_found`, `settlement_batch_not_found`, `treasury_reconciliation_not_found`, `statement_not_issued`, …) |
| Genuinely unexpected | **500** with Nest's fixed body `{"statusCode":500,"message":"Internal server error"}` — never a stack trace, internal id, or financial metadata |

## Response body for governed 409s

```json
{ "statusCode": 409, "error": "Conflict",
  "message": "<specific legacy code>", "code": "<canonical>", "reason": "<specific legacy code>" }
```

Clients key behavior on **`code` only**. `message` and `reason` both carry the
specific legacy string verbatim — `message` stays legacy so pre-contract
clients that read `message` keep resolving their precise operator copy through
the deploy window. Ungoverned machine-code refusals pass through with `code`
echoed as the **stable base** of their message (dynamic `:suffix`es stay in
`message`, never in `code`); prose bodies (guards/validators) pass through
untouched. Mapping lookups are own-property only (`Object.hasOwn`) — prototype
names like `constructor` are not governed refusals.

## Canonical codes → sources

| Canonical `code` (409) | Emitted for (`reason`) |
|---|---|
| `settlement_preview_stale` | `preview_act_required` |
| `settlement_calculation_hash_mismatch` | `preview_hash_mismatch`, `approval_snapshot_stale`, binding `preview_batch/reference/snapshot_mismatch`, `approval_batch/snapshot_mismatch` |
| `settlement_batch_state_conflict` | `preview/approval/execution_requires_ready:<status>`, `batch_drifted`, `settlement_already_remitted`, `settlement_closed_zero_net`, `execution_use_zero_net_close`, `execution_requires_positive_net`, `zero_net_close_requires_exact_zero`, `settled_without_remittance`, `batch_proposer_unknown`, `settlement_batch/items/receivables_contended` |
| `settlement_approval_missing` | binding `approval_required` (no votes exist), `insufficient_approvals` (below required level), `senior_approval_required` (§31.1 senior seat unmet — a level requirement; `reason` says which) |
| `settlement_approval_expired` | new service-level distinction: votes exist but **all lapsed the §31.3 TTL** (acceptance rule unchanged — lapsed votes never counted) |
| `settlement_executor_is_final_approver` | binding `executor_cannot_approve` (§33 strict form; **was a 500**) |
| `settlement_approver_is_proposer` | `approver_cannot_be_proposer` |
| `treasury_attester_cannot_resolve` | itself (already 409) |
| `financial_gates_not_attested` | itself (already 409) |

## Deliberate decisions

- **`replay_not_verified` stays 500 — and always wins.** A frozen record that no
  longer reproduces itself is a P0 integrity alarm, not an operator-recoverable
  conflict. The body is the sanitized fixed 500; the detail goes to the server
  log and Sentry only. The `settlement_approval_expired` distinction is
  translated FROM the binding's own `approval_required` verdict (never a
  pre-check), so every earlier binding check — including the §34 replay alarm —
  keeps its exact precedence (pinned).
- **Mapped §33 violation attempts remain observable**: the filter logs a
  warning and sends a Sentry `warning` message for every mapped binding
  refusal — abuse probing does not become invisible behind a tidy 409 (pinned).
- **`receipt_invoice_not_receivable:<status>` is NOT canonicalized** — it is an
  invoice-document state, not a settlement-batch state; it passes through as its
  own stable code (400, base echoed in `code`).
- **`settlement_nothing_eligible` / `settlement_negative_net_deferred` stay
  400** — pre-batch assembly refusals with long-standing stable codes the
  console already maps; neither is a "changed or closed batch". Kept as-is,
  documented here.
- **`statement_integrity_violation` stays 409** (vs `replay_not_verified`'s
  500): it refuses to RENDER a stored document as authentic — a read-path
  refusal the operator resolves with an administrator — while the replay alarm
  guards EXECUTION off a non-reproducing frozen record.
- **Refund maker–checker refusals** (`refund_self_approval_rejected`, …) keep
  their own stable 409 codes — the refund workflow's separation vocabulary is
  its own; statuses already conform.
- **`reason` echoes `execution_requires_ready:<status>` verbatim** — for a
  caller holding `finance.settlement_execute` this reveals batch lifecycle
  state even without `finance.receipts`. Accepted and documented: every current
  role bundle granting execute also grants receipts, so the boundary is
  presently vacuous; revisit if execute-only roles are ever minted.
- **State-fact refusals thrown as 400 today are corrected to 409 at the
  boundary** (`preview_requires_ready`, `execution_use_zero_net_close`, …): a
  not-ready batch is a state conflict, not malformed input. Service exception
  classes are untouched — unit pins keep passing.
- **No mutation on any refusal**: the filter has no persistence dependencies
  (pinned), and service refusal paths throw before writes (pinned in the
  execution spec's error-contract block).
- **No automatic retry after 409** is a client obligation: the console performs
  mutations only on explicit operator clicks (no retry logic exists), and the
  same-evidence idempotency lane means a manual retry can never duplicate
  execution (pinned: same-evidence re-run returns the same remittance; different
  evidence refuses `remittance_conflict`).

## Amendments

`FINANCE_OPS_ERROR_CONTRACT_VERSION` bumps on any code rename or remap; codes
are append-only stable identifiers — renaming an existing code requires a
frontend release in the same closure and a version bump.
