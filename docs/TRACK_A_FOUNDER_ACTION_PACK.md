# Track A — Founder Action Pack (A10 + A2)

**Status: prepared 2026-07-04.** Everything code-side in Track A is
merged; this document is the remaining HUMAN half. Items are ordered:
**Gate items block pilot money/data; Activation items block pilot
usefulness; Confirmation items block invoice correctness.**

Every env change below is Railway → qift-platform service → Variables
(backend) or Vercel → qift-ui-v2 → Environment Variables (frontend),
followed by a redeploy.

---

## 1. GATE ITEMS — must be done BEFORE the first pilot collection

These two come from the Financial Constitution
(`QIFT_FINANCIAL_PLATFORM_BLUEPRINT_v1.0.md`, Treasury & Safeguarding
+ roadmap floating gates). They gate MONEY, not code.

- [ ] **Treasury / safeguarding account** — a segregated bank account
      for client money (goods value passing through Qift as agent),
      separate from Qift's operating account, BEFORE the first riyal
      of pilot collection. Ask the bank for a client/escrow account;
      document account number + purpose in the ops manual.
- [ ] **Licensing check** — written advisor confirmation of which
      license (if any) the agent-model collection flow requires in
      KSA (payment aggregation vs commercial agency), BEFORE first
      collection. If a PSP holds the funds instead, this gate can be
      satisfied by the PSP's license — get that in writing too.
- [ ] **PDPL interim basis + DPA** — one-page data-processing record:
      what personal data Qift processes (rosters, claims, addresses),
      the legal basis, and a signed DPA template for pilot orgs.
      Advisor review; store in the legal folder.

## 2. ACTIVATION ITEMS — pilot config (A10 / PE-09)

Backend (Railway), exact names as read by the code:

- [ ] `QIFT_DISPATCH_WORKER_ENABLED=true` — turn the dispatch sweep on.
- [ ] `QIFT_DISPATCH_PAUSED` — REMOVE/unset for the pilot (it
      hard-skips every sweep; useful as an emergency brake later).
- [ ] `QIFT_ROSTER_PURGE_ENABLED=true` — retention worker for expired
      roster contacts (PDPL hygiene).
- [ ] `BETA_GATE_ENABLED=true` **decision** — recommended ON for the
      pilot window (closed onboarding; invite codes via admin). Flip
      to unset/false to open registration instantly, no redeploy.
- [ ] `QIFT_CLAIM_BASE_URL=https://qift.net` — claim links must mint
      on the production domain.
- [ ] Confirm `TAQNYAT_BEARER_TOKEN` / `TAQNYAT_SENDER` (SMS) and
      `RESEND_API_KEY` + `EMAIL_FROM`/`OTP_EMAIL_FROM` (email) are set
      in prod — the claim OTP flow is dead without them.

Frontend (Vercel):

- [ ] `NEXT_PUBLIC_HIDE_SAMPLE_STORES=1` — no demo stores in front of
      pilot users.
- [ ] `NEXT_PUBLIC_SUPPORT_EMAIL` — only if the support address ever
      differs from the default `support@qift.net`.

Real-channel test (after the above, ~10 minutes, uses your own phone):

- [ ] Create a 1-contact test campaign in a test org → dispatch →
      receive the REAL SMS on a Saudi number → open claim link →
      email/SMS OTP → reveal → enter address → confirm the claim row
      + address land (ops fulfillment export now exists for this:
      `POST /admin/orgs/:orgId/campaigns/:campaignId/fulfillment-export`).

## 3. OBSERVABILITY + CONTINUITY (A8, A9 — runbooks ready)

- [ ] Sentry: create project, set `SENTRY_DSN` +
      `SENTRY_ENVIRONMENT=production` → follow
      `docs/OBSERVABILITY_RUNBOOK.md` (15 min).
- [ ] Uptime monitor on `GET /health` (same runbook, 5 min).
- [ ] Railway → Postgres → confirm automated daily backups ON →
      `docs/BACKUP_RESTORE_RUNBOOK.md` §Founder checklist (5 min).
      The restore path is PROVEN (drill executed 2026-07-04).
- [ ] Verify the `support@qift.net` mailbox actually receives mail
      (Google Workspace) — /contact now points users at it (A6).

## 4. CONFIRMATION ITEMS — financial facts (A2 / PE-10)

The invoice engine is live and snapshots these facts permanently into
every invoice. Wrong facts = wrong legal documents.

Qift's own identity (Railway env, read by party-snapshot at issuance):

- [ ] `QIFT_LEGAL_NAME` — exact registered legal name.
- [ ] `QIFT_CR_NUMBER` — commercial registration number.
- [ ] `QIFT_VAT_NUMBER` — only once VAT-registered; leave unset until
      then (invoices then correctly carry no Qift VAT number).
- [ ] `QIFT_TAX_COUNTRY=SA` (default already SA — confirm).

Per pilot merchant, BEFORE their first campaign invoice (stored on the
Store record: `vatRegistered`, `vatNumber`, `pricesIncludeVat`):

- [ ] Written confirmation from each merchant: VAT-registered? VAT
      number? Are catalog prices VAT-inclusive (KSA retail default)
      or exclusive? Issuance hard-fails on registered-without-number,
      but only the merchant can tell you the true facts.

Advisor sign-offs (written, filed):

- [ ] **Agent model** — Qift invoices fee-only (150 + 22.5 VAT on a
      5,000 goods campaign); merchant invoices goods. Confirm this
      two-leg structure with the tax advisor against actual pilot
      contracts.
- [ ] **FATOORA Phase-1 floating gate** — before issuing any invoice
      as a VAT-REGISTERED Qift (i.e. once `QIFT_VAT_NUMBER` is set),
      generation must be FATOORA-Phase-1 compliant. Until then this
      gate is dormant; put it in the VAT-registration checklist so it
      cannot be missed later.

---

*When every box above is checked, Track A's exit gate is fully closed
and Pilot #1 may onboard. The code half is already done and merged
(A1, A3–A9 + this pack's referenced runbooks).*
