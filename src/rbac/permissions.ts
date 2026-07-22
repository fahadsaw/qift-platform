// Permission catalog — single source of truth for every named
// permission in the QIFT system (backend mirror).
//
// SCOPE
// Permissions are compile-time constants in code, never DB rows. The
// role-to-permission MAP (apps/api/src/rbac/role-map.ts) can become
// DB-backed later — so operators can edit which roles hold which
// permissions through /admin#team — but the catalog itself stays in
// code so that removing or renaming a permission is always a
// reviewable code change. Permissions are dotted strings
// (`<domain>.<action>` or `<domain>.<subject>.<action>`) — the dots
// are organizational only and the authorization layer treats each
// permission as an opaque string identifier.
//
// DOMAINS
// - ADMIN              : /admin surface + moderation
// - FINANCE            : payouts, reserves, financial config
// - REVIEW             : accountant + legal Stage 10 sign-off
// - AUDIT              : append-only operator-action log
// - FLAG               : feature-flag registry
// - MERCHANT           : per-merchant operational surface
// - MERCHANT_FINANCE   : per-merchant financial dashboard
// - USER               : end-user actions
//
// BACKWARD COMPATIBILITY
// This catalog is currently UNWIRED — nothing reads it for
// authorization yet. The legacy `user.role` field on the User row
// and the existing presentation catalog at
// apps/api/src/ops-roles/ops-roles.ts continue to govern real
// authorization. A later PR will introduce a hasPermission(user,
// perm) helper and migrate guards through it. The admin-side
// permission identifiers below are intentionally a superset of
// apps/api/src/ops-roles/ops-roles.ts so the two catalogs can be
// unified in a follow-up PR without renaming.
//
// PARITY CONSTRAINT
// Every identifier in PERMISSIONS must match the frontend mirror at
// qift-ui-v2/lib/rbac/permissions.ts byte-for-byte. A CI drift check
// (PR B-0b, vendored-snapshot approach) enforces this — adding,
// removing, or renaming any identifier here without the matching
// frontend change will fail CI.

// ---------------------------------------------------------------------
// ADMIN-SIDE PERMISSIONS
// First block mirrors apps/api/src/ops-roles/ops-roles.ts exactly
// (same identifiers, same semantics) so the existing OpsPermission
// type can be refactored to satisfy this catalog in a follow-up PR.
// `admin.access` is new — it is the coarse gate that replaces
// `user.role === 'admin'` in AdminGuard once the kill-switch flag
// lands.
// ---------------------------------------------------------------------

export const ADMIN_PERMISSIONS = [
  'admin.access',

  'store.review',
  'store.set_plan',
  'store.set_featured',
  'store.set_status',
  'store.read_detail',

  'user.read',
  'user.set_role',
  'user.suspend',
  'user.restore',
  'user.purge',
  'user.assign_ops_role',

  'diagnostics.read',
  'diagnostics.run_seed',

  'report.read',
  'report.resolve',

  'analytics.read',

  // Closed-beta gate administration. Holders may create / disable
  // beta invite codes, manage the registration allowlist, and read
  // redemption counts via /admin#beta. Held by super_admin (via the
  // ALL_ADMIN_PERMISSIONS bundle) and operations_manager. Mirrored
  // into ops-roles.ts OPS_PERMISSIONS so the @RequireOpsPermission
  // decorator on the beta controller can reference it.
  'beta.manage',

  // Corporate org review (Corporate Foundation PR 1). Gates the
  // /admin/orgs review queue. Mirrored into ops-roles.ts.
  'org.review',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// FINANCE PERMISSIONS
// Stage 10 finance ops. The SoD constraint for payouts is runtime —
// a user who recorded a payout event (`finance.record_payout_event`)
// cannot approve the same payout, regardless of which role(s) they
// hold. SoD is enforced on the (actor_id, target_id) pair, not on
// the role-permission map.
// ---------------------------------------------------------------------

export const FINANCE_PERMISSIONS = [
  'finance.read_payouts',
  'finance.record_payout_event',
  'finance.approve_payout',
  // Ledger reconciliation (Track B2 / PE-11) — findMissing + repair.
  'finance.reconcile',
  // VAT-facts maker-checker (Track B3 / PE-12). Deliberately NARROWER
  // than finance.write_financial_config (reserved for the Stage 10
  // finance_admin): this grants exactly the merchant-VAT-facts flow.
  'finance.vat_facts',
  // SETTLE-1 (Track C PR 2): payment receipts (record/list), the
  // receivables-aging read model, §5 eligibility evaluation, and
  // payout-identity verification. Collections surface only — batch
  // EXECUTION rights are a separate later permission (SC §31–§33
  // approval/execution separation).
  'finance.receipts',
  // SETTLE-2 (Track C PR 3): the §33.1 TWO POWERS — approval
  // (simulate/assemble/preview/approve: deciding money should move)
  // and execution (making it move) are distinct permissions. Holding
  // both never merges the acts: the RULE 6 binding gate enforces
  // executor ∉ approvers on server-verified identity.
  'finance.settlement_approve',
  'finance.settlement_execute',
  // SETTLE-3a (Track C PR 5): record §8 refunds (credit note + goods
  // posting + settlement interaction), list refunds/receivables.
  'finance.refunds',
  'finance.reject_payout',
  'finance.read_payout_overview',

  'finance.read_reserves',
  'finance.modify_reserve',

  'finance.read_financial_config',
  'finance.write_financial_config',
] as const;

export type FinancePermission = (typeof FINANCE_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// REVIEW PERMISSIONS
// Backs the accountant + legal review-status surface. The sign-off
// permissions are held by external-facing review roles
// (accountant_readonly, compliance_readonly) — `read_status` is the
// observation right, the `sign_off_*` permissions are the gate for
// posting a sign-off.
// ---------------------------------------------------------------------

export const REVIEW_PERMISSIONS = [
  'review.read_status',
  'review.sign_off_accountant',
  'review.sign_off_legal',
] as const;

export type ReviewPermission = (typeof REVIEW_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// AUDIT PERMISSIONS
// Backs the append-only operator-action log. Read is the viewer
// right; export is the cold-storage / dispute-response right. Note
// that apps/api/src/audit/ already exists in this repo — that
// existing audit infrastructure pre-dates the RBAC catalog. When
// `audit.read` / `audit.export` are wired into guards, the existing
// audit endpoints should be the first consumers.
// ---------------------------------------------------------------------

export const AUDIT_PERMISSIONS = ['audit.read', 'audit.export'] as const;

export type AuditPermission = (typeof AUDIT_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// FLAG PERMISSIONS
// Backs the future feature-flag registry. `flag.write_financial` is
// the second-approver gate for dual-approval financial flags — it is
// distinct from `flag.write` so a single principal can never flip a
// financial flag on their own.
// ---------------------------------------------------------------------

export const FLAG_PERMISSIONS = [
  'flag.read',
  'flag.write',
  'flag.write_financial',
] as const;

export type FlagPermission = (typeof FLAG_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// MERCHANT-SIDE PERMISSIONS
// FRP v1.1 § 9.6 + Stage 10 § 19 (W1 merchant RBAC). Operational
// surface for the merchant dashboard — distinct from the finance
// surface below.
//
// NOTE: backend `StoreGuard` does NOT enforce these — it gates on
// ownership of a Store row instead. These permissions back the
// client-side UX gates in the frontend; backend ownership gating is
// preserved as-is.
// ---------------------------------------------------------------------

export const MERCHANT_PERMISSIONS = [
  'merchant.access',
  'merchant.products.read',
  'merchant.products.write',
  'merchant.orders.read',
  'merchant.orders.write',
  'merchant.theme.read',
  'merchant.theme.write',
  'merchant.coverage.read',
  'merchant.coverage.write',
  'merchant.plan.read',
  'merchant.plan.write',
  'merchant.visibility.read',
  'merchant.visibility.write',
  'merchant.analytics.read',
  'merchant.team.read',
  'merchant.team.write',
] as const;

export type MerchantPermission = (typeof MERCHANT_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// MERCHANT FINANCE PERMISSIONS
// Per-merchant financial dashboard (FRP v1.1 § 9.6.3). Kept separate
// from MERCHANT_PERMISSIONS so the access matrix can grant the
// operational surface without leaking financial data, and vice versa.
// ---------------------------------------------------------------------

export const MERCHANT_FINANCE_PERMISSIONS = [
  'merchant_finance.read_own',
  'merchant_finance.request_review',
] as const;

export type MerchantFinancePermission =
  (typeof MERCHANT_FINANCE_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// USER-SIDE PERMISSIONS
// Standard end-user actions. Held by every account by default.
// ---------------------------------------------------------------------

export const USER_PERMISSIONS = [
  'user.profile.read',
  'user.profile.write',
  'user.wishlist.read',
  'user.wishlist.write',
  'user.send_gift',
  'user.receive_gift',
  'user.social.read',
  'user.social.write',
  'user.occasions.read',
  'user.occasions.write',
  'user.notifications.read',
  'user.notifications.write',
] as const;

export type UserPermission = (typeof USER_PERMISSIONS)[number];

// ---------------------------------------------------------------------
// UNION
// `Permission` is the canonical type used throughout the RBAC layer.
// `PERMISSIONS` is the iterable form. Both are derived from the
// per-domain catalogs above so the union stays in sync automatically.
// ---------------------------------------------------------------------

export type Permission =
  | AdminPermission
  | FinancePermission
  | ReviewPermission
  | AuditPermission
  | FlagPermission
  | MerchantPermission
  | MerchantFinancePermission
  | UserPermission;

export const PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  ...FINANCE_PERMISSIONS,
  ...REVIEW_PERMISSIONS,
  ...AUDIT_PERMISSIONS,
  ...FLAG_PERMISSIONS,
  ...MERCHANT_PERMISSIONS,
  ...MERCHANT_FINANCE_PERMISSIONS,
  ...USER_PERMISSIONS,
];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
