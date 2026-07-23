# Database-Level Append-Only Protection (Lane 2 PR 3, Scope B)

**Constitutional basis:** SC §11 (single append-only write path, no
update/delete ever), §17 (create-only audit), §24 (forward-only
corrections); FC Ch. 4 (immutable documents), Ch. 5 (append-only
ledger). Migration: `20260724150000_financial_integrity_hardening`.

## Mechanism

`BEFORE UPDATE OR DELETE` triggers (`qift_forbid_mutation()`) raise
`append_only_violation` at the DATABASE itself. This is the strongest
practical layer on managed Postgres: the application connects as the
table owner, so `REVOKE` cannot bind it — triggers can. Application
services additionally expose no update/delete paths (source-pinned in
`src/financial/integrity-hardening.spec.ts`); the live-database proof
runs via `scripts/verify-append-only.mjs` against the scratch DB in
the gate sequence.

## Protected (constitutionally immutable)

| Table | Why |
|---|---|
| `FinancialLedgerEntry` | The ledger IS the event log — never edited (SC §11) |
| `AuditLog` | Create-only audit trail (SC §17) |
| `CreditNoteVersion` | Immutable legal-document versions (RC/FC Ch. 4) |
| `SettlementStatementRecord` | Issued statements are immutable (RULE 4) |
| `SettlementStatementSignature` | Append-only signature envelopes |
| `SettlementReplayRecord` | Append-only verification acts (§34) |
| `SettlementRemittance` | Immutable bank-movement evidence (§13.2) |
| `SettlementApproval` | Immutable votes — recast = new row (§31.5) |
| `SettlementExecutionPreview` | Immutable recorded acts (§30.4) |
| `PaymentReceipt` | Immutable cash-in evidence (§18.1) |
| `TreasuryAttestation` | Append-only bank evidence (PR 1) |
| `TreasuryInternalTransfer` | Append-only transfer evidence (Scope C); partial unique: ONE completed row per settlement |
| `SettlementRefund` | Immutable cash-out evidence — corrections are compensating entries (§8/§24) |

Corrections remain **compensating entries or new document versions** —
never mutations (proven by the verify script: an INSERT of a
compensating row succeeds while UPDATE/DELETE of the original fails).

## Stateful by constitution (deliberately NOT protected)

`SettlementBatch` (lifecycle columns: status, failureEvidence,
supersededById, closureType, closedAt — frozen fields guarded by RULE
3 pins), `SettlementItem` (state law), `SettlementReceivable`
(5-state lifecycle), `TreasuryReconciliation` (pending → matched /
mismatched → investigated → resolved), `RefundRequest` (maker–checker
lifecycle), `CreditNote` (head row = version-pointer cache; the
immutable bytes live in `CreditNoteVersion`), `CorporateInvoice` /
`MerchantInvoice` (status/paidAt/balanceStatus lifecycle),
`NumberSequence` (sequential allocator), `PayoutEvent` (legacy,
frozen, zero rows — retired as a truth source, Scope E).

## Recorded decisions

- **Heal-dedupe (review finding 6):** the execution/zero-net
  completion-tail audits key per settlement — a healed re-delivery
  collides into the original key by design, so the FACT that a heal
  ran survives in logs/return values, not as a second guaranteed
  audit row. Absence of healed-audit rows is NOT absence of heals.
- **Genuine double-sweep (review finding 3):** if the bank truly
  moves the same due twice, the second movement is UNRECORDABLE here
  by design (partial unique) — it surfaces as a bank-vs-cash
  attestation mismatch and is corrected by a compensating treasury
  action recorded through the constitutional lanes, never by editing
  evidence.

## Rollback

Triggers are additive DDL; rollback = revert code. Dropping a trigger
is a constitutional amendment (it removes an enforcement layer), never
routine.
