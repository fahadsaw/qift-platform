# Canonical Reference Architecture

**Track A.5 — Canonical References & Order Tracking.**
Status: living document; sections marked *(shipped)* are merged, others
land with their PR. Governs every human-readable identifier Qift issues.
Where this document and `QIFT_FINANCIAL_PLATFORM_BLUEPRINT_v1.0.md`
(the frozen Financial Constitution) touch, the Constitution wins; this
document implements it and records the mapping.

## 1. Why references exist

The pre-A.5 audit (2026-07-19) found that every identifier any actor
could see — orders, gifts, campaigns, claims, invoices — was a raw
database cuid. No search accepted anything human. Support had nothing
quotable; invoices had no numbers; merchants could not retrieve a
delivered order. This architecture closes that with **one grammar, one
generator, one normalizer** (`src/references/reference.ts`).

## 2. The prefix registry *(shipped, PR 1)*

| Prefix | Object | Kind | Format | Issued when |
|---|---|---|---|---|
| **QP** | Personal order | random | `QP-XXXX-XXXX` | order creation |
| **QB** | Business campaign / corporate purchase | random | `QB-XXXX-XXXX` | campaign creation |
| **QG** | Recipient gift (one recipient's journey in a campaign) | random | `QG-XXXX-XXXX` | claim mint |
| **QF** | Merchant fulfillment order | random | `QF-XXXX-XXXX` | gift creation |
| **QC** | Qift service-fee invoice | **sequential** | `QC-YYYY-NNNNN` | invoice issuance (transactional) |
| *(merchant invoice)* | Merchant goods invoice | **not Qift-issued** | merchant's own series | see §5 |
| **QS** | Settlement reference | **reserved** | `QS-XXXX-XXXX` | Track C — generation refuses it today |
| *(carrier)* | Shipment tracking | carrier-issued | carrier format | merchant enters it; already modeled (`Shipment.trackingNumber` + `provider` + `trackingUrl`) |

Separate legal/operational objects keep separate references — a QB is a
purchase, a QG is one recipient's slice of it, a QF is a merchant's
work item, a QC is a legal document. They never merge.

## 3. Reference properties (constitutional)

Operational references (QP/QB/QG/QF) are:

- **human-readable** — 31-symbol alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  (no 0/O/1/I/L); survives handwriting, phone calls, and screenshots;
- **immutable** — written once at object creation (or backfill), never
  regenerated, never recycled; status changes, cancellation,
  replacement, and refund NEVER touch the reference (§7);
- **unique** — DB `UNIQUE` index per column; allocator retries on
  collision (bounded, 5 attempts) and insert-time P2002 counts as a retry;
- **random, non-sequential** — no volume leakage, no enumeration;
  8 chars ≈ 8.5×10¹¹ combinations;
- **safe to expose** — carries zero personal data by construction;
- **case-insensitive, dash-optional in search** — `normalizeReference`
  maps `qb 7xkm 3npq` → `QB-7XKM-3NPQ`; storage is always canonical;
- **NOT an authentication secret** — possession grants nothing. Claim
  links keep their 256-bit hashed tokens; references never replace them;
- **authorization-gated** — every lookup passes ownership / org tenancy
  / merchant scoping / ops RBAC. A reference in the wrong hands
  resolves to nothing.

Legal invoice numbers (QC, §4) are sequential **only because the law
prefers an unbroken series**, and are allocated inside the same
database transaction that creates the invoice row.

## 4. Qift service invoice numbering (QC) — agent-model position

Under the frozen Financial Constitution, Qift is the **agent**: its own
legal document is the service-fee invoice (fee + VAT on fee only). QC
numbering therefore applies to `CorporateInvoice` ONLY:

- Series per issue year: `QC-2026-00001`, `QC-2026-00002`, …
- Allocated via the `NumberSequence` table inside the invoice-creation
  transaction: a failed create rolls the allocation back (no gaps from
  failed attempts); a duplicate-campaign race returns the existing row
  and allocates nothing.
- The number freezes at issuance and never changes; a future FATOORA
  Phase-1 pipeline consumes it (or maps it via
  `externalAccountingInvoiceId` if the e-invoicing provider issues its
  own — both survive because the fields are separate).

## 5. Merchant goods invoice — NO manufactured numbers

The merchant is the **legal seller** of the goods. Qift does not and
must not silently mint a merchant's legal invoice number. The
`MerchantInvoice` row is Qift's *facilitation record* of the goods leg
— not the legal document itself. It carries:

- `merchantInvoiceNumber` — the number from the merchant's own series,
  supplied by the merchant (or connector). Nullable until supplied.
- `merchantInvoiceExternalId` — the id in the merchant's accounting
  system / connector.
- `merchantInvoiceUrl` — pointer to the merchant-hosted or
  connector-hosted legal document.
- `invoiceNumberSource` — `MERCHANT` (default; merchant supplies) |
  `ACCOUNTING_CONNECTOR` (pulled via a future connector) |
  `QIFT_ON_BEHALF` (Qift issues **only** with contractual authorization).
- `onBehalfAuthorizationRef` — REQUIRED when source is
  `QIFT_ON_BEHALF`: a pointer to the signed authorization (contract
  clause / document id). Writes without it are rejected.

**Authorization path for QIFT_ON_BEHALF:** merchant signs an
invoicing-mandate clause (legal advisor drafts it — tracked in the
founder action pack); ops records the evidence reference; only then may
a Qift-side series be configured for that merchant. No production
default assumes this; until legal confirmation exists, every merchant
invoice is `MERCHANT`-sourced with the number pending.

## 6. Authorization matrix

| Reference | Buyer/sender | Recipient | Company (org) | Merchant | Ops/admin | Support usage |
|---|---|---|---|---|---|---|
| QP | ✅ own orders | ❌ | ❌ | ❌ | ✅ (diagnostics.read) | buyer quotes it |
| QB | ❌ | ❌ | ✅ own org | ❌ | ✅ (org.review) | company quotes it |
| QG | ❌ | ✅ own claim screen | ❌ (privacy: org never sees per-recipient state) | ✅ fulfillment export rows | ✅ (org.review) | recipient/merchant quote it |
| QF | ✅ via own gift | ✅ via own gift | ❌ | ✅ own store's orders | ✅ (diagnostics.read) | merchant quotes it |
| QC | ❌ | ❌ | ✅ own org invoice | ❌ | ✅ (org.review) | invoice disputes |
| merchant inv. no. | ❌ | ❌ | ✅ (it's their purchase doc) | ✅ own | ✅ (org.review) | goods-leg disputes |
| carrier tracking | ✅ | ✅ | ❌ | ✅ | ✅ | delivery chasing |

The employer-blind invariant is untouched: QG gives the org NOTHING —
org surfaces never resolve it; only ops and the parties themselves can.

## 7. Lifecycle & immutability rules

1. A reference is allocated exactly once, at object creation (or the
   one-time backfill migration) — inside the same transaction/insert.
2. No update path may write a reference column. Enforced by review +
   spec pins (each consuming PR adds a test that its update/mutation
   services never touch the column).
3. Status transitions, cancellation, refund, replacement, re-shipment:
   the reference is stable through all of them. A replacement shipment
   changes `Shipment` rows, never QF/QP. A refund changes money rows,
   never any reference.
4. References are never recycled, even from deleted/purged objects.
   (Purge keeps the row's reference column or deletes the row whole —
   a freed reference is never re-issuable because allocation is random
   over 8.5×10¹¹ and checked against live rows only; the collision
   chance against purged history is ignorable by design.)
5. QC values are never re-sequenced. A voided invoice keeps its number
   (voiding is a status, not a deletion) — required for an auditable
   series.

## 8. Backfill & rollback plan

Verified prod state (read-only, 2026-07-19): GiftCampaign **0** rows,
ClaimableGift **0**, CorporateInvoice **0**, MerchantInvoice **0**,
Order **11**, Gift **19**.

- QB/QG/QC/merchant-invoice migrations therefore backfill **zero
  production rows** — the backfill logic exists for dev/CI databases
  and correctness, and is tested there.
- QP/QF backfill touches 11 + 19 rows: a `DO $$` plpgsql block
  generates alphabet-conformant random references per existing row,
  then the column is set `NOT NULL` + `UNIQUE`. At 30 rows the
  collision probability is ~0; the block still loop-checks.
- Every migration is: additive column → backfill → constrain. No
  destructive step. **Rollback** = drop the column(s) and (PR 4) the
  `NumberSequence` table; no other table is touched, so `migrate diff`
  down-scripts are one-liners recorded in each PR body. Application
  code degrades to pre-A.5 behavior if a column vanishes (references
  are additive to every response shape).
- Each schema PR re-verifies prod counts read-only before merge.

## 9. Search contract

All search inputs pass through `normalizeReference` first; a canonical
hit routes to the object's authorized lookup; a non-reference falls
through to the surface's existing text search. Endpoints added per PR
(merchant `?q=`, ops cross-reference search, buyer order list).
