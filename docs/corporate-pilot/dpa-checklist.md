# DPA Clause Checklist (PDPL-aligned, pilot-grade)

Roles: Company = controller of roster data; Qift = processor for the
roster, controller of the recipient-entered delivery address (collected
directly from the data subject for delivery, disclosed in the claim
notice). Merchant = sub-processor for delivery only.

- [ ] **Subject matter + duration**: one named campaign; processing ends at purge (D+30 post-delivery)
- [ ] **Data categories**: name, mobile, optional email, optional group — exhaustive list; anything else refused
- [ ] **Purposes**: dispatch, claim handling, delivery, funnel reporting — exhaustive
- [ ] **Processor obligations**: process on documented instructions only; confidentiality undertakings for named staff (max 2 with vault access)
- [ ] **Security measures**: secured vault, access register, no third-party form tools, encrypted transfer channel
- [ ] **Sub-processors NAMED**: fulfilling merchant(s); SMS provider (Taqnyat); email provider (Resend); hosting (Railway/Cloudflare) — with cross-border transfer mechanism stated
- [ ] **No-disclosure-to-controller clause**: delivery addresses are never provided to the company (and the company covenants not to request them)
- [ ] **Data subject rights**: route roster DSRs to the company (we assist); Qift honors address-deletion directly post-delivery; opt-out honored platform-wide
- [ ] **Breach notice**: 72h to the company with scope + actions
- [ ] **Retention + purge**: D+30 purge, certificate issued; financial/audit trail retains amounts + events only (no personal data)
- [ ] **Audit right**: paper-based attestation for pilot tier
- [ ] **Return/deletion on termination**: purge + certificate; no copies
- [ ] **Liability**: capped at fees paid (pilot tier)
- [ ] **Governing law**: KSA; PDPL referenced explicitly
