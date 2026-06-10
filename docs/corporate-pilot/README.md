# Corporate Concierge Pilot — Execution Pack

Operational pack for the approved Corporate Gifting v2 concierge
pilots (Lane A: zero-code, ops-run). Source of truth for running
pilots 1–3. Architecture lives in the Corporate Core v2 package;
this pack is the *how-to-run-it* layer.

| Doc | Purpose |
|---|---|
| `sales-deck.md` | Founder-led pitch — narrative, slides, objection handling |
| `onboarding-workflow.md` | Company onboarding, step by step, with owners |
| `pilot-checklist.md` | The campaign runbook as a checkable list (D-10 → D+30) |
| `company-requirements.md` | What we need FROM the company, and what we promise |
| `merchant-requirements.md` | Bulk fulfillment addendum checklist |
| `dpa-checklist.md` | Data Processing Agreement clause checklist (PDPL-aligned) |

Non-negotiables carried from the approved design:
- The company NEVER sees employee delivery addresses (structural).
- Employees NEVER need a Qift account; claim = link + OTP + address.
- Roster PII handled as processor under the DPA; purge at D+30 with certificate.
- Claimed gifts are the recipient's — irrevocable.
- Prepayment before dispatch, every pilot, no exceptions.
