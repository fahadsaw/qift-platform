// Role → Permission mapping (backend mirror).
//
// Source of truth for "which role holds which permissions". Currently
// code-only; can become DB-backed in a later phase (operators
// editing role grants through /admin#team) without changing
// consumers of the helpers below.
//
// TYPE-LEVEL INVARIANTS
// The `Record<Role, readonly Permission[]>` shape guarantees:
//   - every Role has an entry (adding a Role without updating this
//     map is a typecheck error)
//   - every entry contains only valid Permission identifiers (typos
//     fail to compile)
// These invariants are intentionally enforced at the type level so
// drift between the catalog and this map is impossible.
//
// LEGACY ROLE MAPPINGS
// The three legacy roles preserve current behaviour exactly:
//   legacy_admin  → every admin-side permission        (≡ super_admin)
//   legacy_store  → every merchant-side permission     (≡ merchant_owner)
//   legacy_user   → every user-side permission         (≡ user_standard)
// They are kept distinct from super_admin / merchant_owner /
// user_standard so a later migration can move individual accounts
// from a legacy role to a narrower W1 role without ambiguity in the
// audit log (legacy → ops_admin is observable; super_admin →
// super_admin is not).
//
// QIFT ROLE MAPPINGS
// First eight roles match apps/api/src/ops-roles/ops-roles.ts
// permission lists, with one addition: `admin.access` is granted to
// every QIFT role here, since every QIFT role exists to interact
// with /admin. The legacy presentation catalog in
// apps/api/src/ops-roles/ops-roles.ts does not yet model
// admin.access as a permission; this catalog does.
//
// NOT WIRED YET
// `permissionsForRoles` and `roleHasPermission` are exported but no
// guard reads from them. PR B-2 introduces a hasPermission(user,
// perm) helper on top of these; PR B-4+ migrate guards
// endpoint-by-endpoint behind a kill-switch flag.

import {
  ADMIN_PERMISSIONS,
  FINANCE_PERMISSIONS,
  REVIEW_PERMISSIONS,
  AUDIT_PERMISSIONS,
  FLAG_PERMISSIONS,
  MERCHANT_PERMISSIONS,
  MERCHANT_FINANCE_PERMISSIONS,
  USER_PERMISSIONS,
  type Permission,
} from './permissions';
import { ROLES, type Role } from './roles';

// Aggregated bundles — what the broadest role in each tier holds.
const ALL_ADMIN_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  ...FINANCE_PERMISSIONS,
  ...REVIEW_PERMISSIONS,
  ...AUDIT_PERMISSIONS,
  ...FLAG_PERMISSIONS,
];

const ALL_MERCHANT_PERMISSIONS: readonly Permission[] = [
  ...MERCHANT_PERMISSIONS,
  ...MERCHANT_FINANCE_PERMISSIONS,
];

const ALL_USER_PERMISSIONS: readonly Permission[] = [...USER_PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // -----------------------------------------------------------------
  // LEGACY (backward-compat — preserves current behaviour exactly)
  // -----------------------------------------------------------------
  legacy_admin: ALL_ADMIN_PERMISSIONS,
  legacy_store: ALL_MERCHANT_PERMISSIONS,
  legacy_user: ALL_USER_PERMISSIONS,

  // -----------------------------------------------------------------
  // QIFT-SIDE
  // First eight: same permission sets as
  // apps/api/src/ops-roles/ops-roles.ts, plus admin.access on each
  // (every QIFT role accesses /admin).
  // -----------------------------------------------------------------
  super_admin: ALL_ADMIN_PERMISSIONS,

  operations_manager: [
    'admin.access',
    'store.review',
    'store.set_status',
    'store.set_featured',
    'store.read_detail',
    'user.read',
    'diagnostics.read',
    'diagnostics.run_seed',
    'report.read',
    'analytics.read',
    // Closed-beta gate administration (mirror of the
    // PERMISSIONS_BY_ROLE.operations_manager grant in ops-roles.ts).
    // super_admin holds this implicitly via ALL_ADMIN_PERMISSIONS.
    'beta.manage',
    // Audit-trail viewer (PR 11) — mirror of ops-roles.ts.
    'audit.read',
    // Corporate org review (CF PR 1) — mirror of ops-roles.ts.
    'org.review',
  ],

  // Mirrors apps/api/src/ops-roles/ops-roles.ts `finance` permission
  // list EXACTLY, with `admin.access` added (the new catalog's
  // coarse /admin gate; the legacy presentation catalog assumes
  // this is true by virtue of `user.role === 'admin'`). Holders
  // gain NO new rights when guards migrate from the legacy role
  // check to permission checks. The expanded Stage 10 finance role
  // is `finance_admin`, defined separately below.
  finance: [
    'admin.access',
    'finance.read_payouts',
    'finance.record_payout_event',
    'finance.approve_payout',
    'finance.reconcile',
    'store.read_detail',
    'analytics.read',
  ],

  merchant_review: [
    'admin.access',
    'store.review',
    'store.read_detail',
    'store.set_status',
  ],

  support: [
    'admin.access',
    'store.read_detail',
    'user.read',
    'diagnostics.read',
    'report.read',
  ],

  trust_safety: [
    'admin.access',
    'user.read',
    'user.suspend',
    // user.restore mirrors the user.suspend grant set — the
    // operator who can disable should be able to restore. Pre-
    // existing gap from the backend/identity-and-admin-controls
    // commit C2 (the permission was added to ops-roles.ts but not
    // mirrored here, where OpsRoleGuard's flag-ON path actually
    // reads). Fixed alongside the user.purge addition below.
    'user.restore',
    'report.read',
    'report.resolve',
    'store.set_status',
    // Audit-trail viewer (PR 11) — mirror of ops-roles.ts.
    'audit.read',
  ],

  fulfillment_ops: ['admin.access', 'store.read_detail', 'diagnostics.read'],

  analytics_viewer: ['admin.access', 'analytics.read'],

  // Stage 10 review-status surface — read-only by definition. The
  // sign-off permissions are the only "write" rights these roles
  // hold, and they are scoped to the review-status flow only.
  accountant_readonly: [
    'admin.access',
    'finance.read_payouts',
    'finance.read_reserves',
    'finance.read_financial_config',
    'finance.read_payout_overview',
    'review.read_status',
    'review.sign_off_accountant',
    'analytics.read',
    'audit.read',
  ],

  compliance_readonly: [
    'admin.access',
    'review.read_status',
    'review.sign_off_legal',
    'store.read_detail',
    'user.read',
    'report.read',
    'analytics.read',
    'audit.read',
  ],

  // Expanded Stage 10 finance role — the broader counterpart to
  // `finance` above. Adds reserves, financial-config, payout-overview
  // (the cross-merchant operator view), reject_payout (the alternate
  // decision to approve), and audit visibility for finance actions.
  //
  // INTENTIONALLY NOT GRANTED TO ANY EXISTING ACCOUNT BY DEFAULT.
  // Promotion from `finance` to `finance_admin` is an explicit
  // operator-by-operator assignment in the future PR B-11 migration
  // step. Until then, every operator currently holding `finance`
  // keeps exactly the rights they have today.
  //
  // The SoD constraint for payouts is runtime: a user who recorded a
  // payout event (`finance.record_payout_event`) cannot approve the
  // same payout, regardless of which role(s) they hold. SoD is
  // enforced on the (actor_id, target_id) pair, not on the
  // role-permission map.
  finance_admin: [
    'admin.access',
    'finance.read_payouts',
    'finance.record_payout_event',
    'finance.approve_payout',
    'finance.reject_payout',
    'finance.read_payout_overview',
    'finance.read_reserves',
    'finance.modify_reserve',
    'finance.read_financial_config',
    'finance.write_financial_config',
    'store.read_detail',
    'analytics.read',
    'audit.read',
  ],

  // -----------------------------------------------------------------
  // MERCHANT-SIDE (FRP v1.1 § 9.6.3 + Stage 10 § 19 W1)
  // The access matrix in FRP § 9.6.3 keeps the operational surface
  // (merchant_manager, merchant_staff) intentionally separate from
  // the financial surface (merchant_finance,
  // merchant_accountant_readonly) — operational roles must not see
  // sensitive financial detail.
  // -----------------------------------------------------------------
  merchant_owner: ALL_MERCHANT_PERMISSIONS,

  merchant_owner_delegate: ALL_MERCHANT_PERMISSIONS,

  merchant_finance: [
    'merchant.access',
    'merchant.orders.read',
    'merchant.analytics.read',
    'merchant_finance.read_own',
    'merchant_finance.request_review',
  ],

  merchant_accountant_readonly: [
    'merchant.access',
    'merchant.orders.read',
    'merchant.analytics.read',
    'merchant_finance.read_own',
  ],

  merchant_manager: [
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
    'merchant.visibility.read',
    'merchant.visibility.write',
    'merchant.analytics.read',
  ],

  merchant_staff: [
    'merchant.access',
    'merchant.products.read',
    'merchant.orders.read',
    'merchant.orders.write',
    'merchant.coverage.read',
  ],

  // -----------------------------------------------------------------
  // USER-SIDE
  // -----------------------------------------------------------------
  user_standard: ALL_USER_PERMISSIONS,
};

// Returns the union of permissions held by any of the given roles.
// Callers pass the full role set for a user (or a single role); the
// result is a Set for O(1) membership checks at the call site.
//
// NOT WIRED YET — no guard consumes this helper. PR B-2 introduces
// hasPermission(user, perm) that derives the user's role set (from
// `User.role` via legacyRoleFor, then later from
// UserRoleAssignment when that table lands) and delegates here.
export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role]) out.add(p);
  }
  return out;
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// Reverse lookup: every role that holds the given permission. Useful
// for "who can do X?" UI affordances in a later Team-tab PR (e.g.
// surfacing which role to assign in order to grant a given right).
export function rolesWithPermission(permission: Permission): readonly Role[] {
  const out: Role[] = [];
  for (const role of ROLES) {
    if (ROLE_PERMISSIONS[role].includes(permission)) out.push(role);
  }
  return out;
}
