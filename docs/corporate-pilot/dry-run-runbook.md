# Corporate Pilot — Activation Dry-Run Runbook

**Purpose:** one full end-to-end rehearsal of the corporate pipeline in
production — org → review → seats → roster → campaign → maker–checker
approval → dispatch → real claim on a real phone → coverage-checked
address → F7 report — using a clearly-labeled **test org** and the
team's own phone numbers, before any real company touches the system.

This is also the **F1 rehearsal** required by the pilot checklist: a
human must SEE that the claim page shows nothing identifying before
OTP.

**Run this with two people** (called **A = owner/maker** and
**B = approver/checker** below). The SoD lock is real: one person
cannot run the approval step alone, by design.

---

## 0. Prerequisites — check before booking the hour

| # | Prerequisite | How to check |
|---|--------------|--------------|
| 1 | CF PRs 1–6 + 7a merged, Railway deployed | `/health` commit matches main |
| 2 | **PR 7b: ops claim-link export — see "Known gap" below** | merged |
| 3 | Two real consumer accounts (A and B) with known passwords | log in to both |
| 4 | A Qift ops account holding `org.review` (super_admin or operations_manager) | `/admin` loads |
| 5 | One **approved** store with one **in-stock** product (a real pilot-friendly product or a test store) | store page renders, product visible |
| 6 | Two team phone numbers willing to receive OTP SMS | — |
| 7 | Railway env access (to flip the worker flag) | — |
| 8 | SMS transport (Taqnyat) configured — it already powers login OTP | log in via phone OTP once |

### Known gap — PR 7b required before the dry-run

Claim tokens are hashed at rest (by design — a DB leak yields no
usable links). With the `ManualDispatchProvider`, the raw claim URL is
generated inside the worker, handed to the provider, and **never
stored** — so today, ops cannot produce the distribution list the
manual-share model depends on.

**PR 7b (small):** an ops-gated export endpoint
(`POST /admin/orgs/:orgId/campaigns/:campaignId/claim-links`) that
re-mints each dispatched job's claim via the existing
`ClaimMintService.mintForJob` (which **rotates** the token on pending
claims — old links die, which is correct because export *is* the
distribution step) and returns `{ contactName, channel, claimUrl }`
rows for ops to hand over. Finalized claims are skipped (mint refuses
them). Without PR 7b, step 6 below has no legitimate way to obtain the
claim URLs.

---

## 1. Environment preparation (ops)

1. Confirm the worker is **OFF**: `QIFT_DISPATCH_WORKER_ENABLED` unset
   on Railway.
2. Confirm the brake exists in your notes: setting
   `QIFT_DISPATCH_PAUSED=true` stops the sweep without a restart —
   this is the abort lever at every step after dispatch.
3. Optional: `QIFT_CLAIM_TTL_DAYS` (default 30) is fine for the test.
4. Have `npx prisma migrate status` output handy (should be clean).

All API calls below: `BASE=https://qift-platform-production.up.railway.app`,
`AUTH_A` / `AUTH_B` / `AUTH_OPS` = `Authorization: Bearer <jwt>` for
each persona (grab tokens from the app's login response or browser
storage).

---

## 2. Org spine (A = owner, then ops review)

```bash
# A creates the TEST org — keep the name unmistakably test:
curl -s -X POST $BASE/org -H "$AUTH_A" -H 'Content-Type: application/json' -d '{
  "legalName": "QIFT INTERNAL DRY-RUN — DELETE AFTER TEST",
  "displayName": "Qift Dry-Run",
  "displayNameAr": "تجربة داخلية",
  "crNumber": "0000000000"
}'
# → note the org id as ORG

curl -s -X POST $BASE/org/$ORG/submit -H "$AUTH_A"          # draft → submitted

# Ops approves:
curl -s $BASE/admin/orgs?status=submitted -H "$AUTH_OPS"
curl -s -X POST $BASE/admin/orgs/$ORG/review -H "$AUTH_OPS" \
  -H 'Content-Type: application/json' -d '{"action":"approve"}'
```

**Check:** `GET /org/$ORG` as A shows `status: approved` and does NOT
include reviewer identity.

## 3. Seats (A seats B as approver)

```bash
curl -s -X POST $BASE/org/$ORG/members -H "$AUTH_A" \
  -H 'Content-Type: application/json' \
  -d '{"qiftUsername": "@<B_username>", "role": "approver"}'
curl -s $BASE/org/$ORG/members -H "$AUTH_A"
```

**Negative checks (expected failures):**
- B calls `GET /org/$ORG/members` → **403** (owner-only).
- A adds B again → **409** `member_already_seated`.
- A adds anyone with `"role": "owner"` → **400** `member_role_invalid`.

## 4. Roster (A)

```bash
# Happy path — 2 contacts, YOUR OWN phones:
curl -s -X POST $BASE/org/$ORG/contacts/import -H "$AUTH_A" \
  -H 'Content-Type: application/json' -d '{
  "csv": "name,phone\nTester One,05XXXXXXXX\nTester Two,05YYYYYYYY\n"
}'
```

**Negative check (THE privacy gate):** import a CSV with an address
column and confirm the whole file is refused:

```bash
curl -s -X POST $BASE/org/$ORG/contacts/import -H "$AUTH_A" \
  -H 'Content-Type: application/json' -d '{
  "csv": "name,phone,home address\nX,0500000000,Riyadh\n"
}'
# → 400, code roster_address_columns_forbidden, columns: ["home address"]
```

## 5. Campaign + maker–checker approval

```bash
# A drafts:
curl -s -X POST $BASE/org/$ORG/campaigns -H "$AUTH_A" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dry-run wave","message":"كل عام وأنتم بخير 🎁"}'
# → CAMP

curl -s -X PUT $BASE/org/$ORG/campaigns/$CAMP/gift-option -H "$AUTH_A" \
  -H 'Content-Type: application/json' -d '{"productId":"<PRODUCT_ID>"}'

# contact ids from GET /org/$ORG/contacts:
curl -s -X POST $BASE/org/$ORG/campaigns/$CAMP/recipients -H "$AUTH_A" \
  -H 'Content-Type: application/json' -d '{"contactIds":["<C1>","<C2>"]}'

curl -s -X POST $BASE/org/$ORG/campaigns/$CAMP/submit -H "$AUTH_A"
```

**Negative check (SoD):** A tries to approve their own campaign →
**403** `campaign_sod_creator_cannot_approve`.

```bash
# B approves (the only path that works):
curl -s -X POST $BASE/org/$ORG/campaigns/$CAMP/approve -H "$AUTH_B"
```

**Check:** `GET /org/$ORG/campaigns/$CAMP` (A) shows
`status: approved` and the option now carries `approvalSnapshot` with
the product + store identity frozen.

## 6. Dispatch (A triggers; ops flips the worker)

```bash
curl -s -X POST $BASE/org/$ORG/campaigns/$CAMP/dispatch -H "$AUTH_A"
# → { ok: true, jobs: 2 }; campaign → dispatching
```

Ops, on Railway: set `QIFT_DISPATCH_WORKER_ENABLED=true` → redeploy.
Within ~60s of boot:

```bash
curl -s $BASE/org/$ORG/campaigns/$CAMP/dispatch-status -H "$AUTH_A"
# → jobs: { dispatched: 2 }; campaign flips to completed on the next sweep
```

Ops exports the claim links (**PR 7b**) and shares them with the two
testers — exactly how a pilot company would receive them.

## 7. The claim — the heart of the rehearsal

Tester One opens their link on a phone:

1. **F1 VISUAL ACCEPTANCE (screenshot this):** the page shows ONLY
   "هدية بانتظارك" + a masked channel hint. **No name. No company. No
   gift.** If anything identifying is visible pre-OTP, STOP — file it
   as a release blocker.
2. **Anti-enumeration:** edit one character of the token in the URL →
   the same generic "link no longer active" screen. No difference.
3. Send code → SMS arrives on the bound phone → enter it.
4. **Identity echo:** "أهلًا <name> 👋 — هدية لك من تجربة داخلية" +
   the gift + the message. Confirm "هذه الهدية ليست لي" is visible
   (don't tap it on this run).
5. **Out-of-coverage check:** submit an address in a city the store
   does NOT cover → calm inline coverage notice, form still editable.
6. Submit a covered address → success screen.
7. **Irrevocability:** reopen the same link → generic "no longer
   active" screen.

Tester Two opens their link, verifies OTP, and taps **decline**
(confirm step) — this seeds the F7 check.

## 8. F7 report check (B or A — and ideally a viewer seat)

```bash
curl -s $BASE/org/$ORG/campaigns/$CAMP/report -H "$AUTH_B"
```

**Acceptance:** `gifts: { issued: 2, claimed: 1, pending: 0,
didNotParticipate: 1 }` — and the word "declined" appears **nowhere**.
The org cannot tell declining from ignoring from a roster error.

Ops cross-check: `GET /admin/orgs/$ORG/campaigns/$CAMP/report` shows
the full breakdown (`declined: 1`) — granularity lives on the ops
plane only.

**Address privacy spot-check (ops, read-only SQL):** the ClaimAddress
row exists; confirm NO org-plane or admin endpoint returned it at any
step. It is write-only by design.

## 9. Wind-down + cleanup

1. Railway: either unset `QIFT_DISPATCH_WORKER_ENABLED` (back to
   pre-pilot state) or leave it on if pilot 1 is imminent — decide
   explicitly, don't drift.
2. Delete the test org (ops, SQL):
   `DELETE FROM "Organization" WHERE id = '<ORG>';`
   CASCADE removes seats, contacts, campaigns, options, recipients,
   jobs, and claims (incl. the ClaimAddress). AuditLog rows remain —
   they are the record of the rehearsal, keep them.
3. File the friction log (below) before everyone forgets.

## Abort levers (any step)

- `QIFT_DISPATCH_PAUSED=true` — freezes the dispatch sweep instantly.
- `QIFT_DISPATCH_WORKER_ENABLED` unset + redeploy — stops the worker.
- Campaign not yet dispatched? `POST .../cancel` works from any
  pre-dispatch state.

## Friction log template

| # | Step | What happened | Severity (blocker / annoying / cosmetic) | Fix idea |
|---|------|---------------|------------------------------------------|----------|
|   |      |               |                                          |          |

The friction log is the design input for the Org Console frontend —
that's the order of operations: rehearse first, then build the
console around what actually hurt.
