// Role catalog — single source of truth for every named role in QIFT
// (backend mirror).
//
// GROUPS
// - LEGACY roles   = the three values currently stored in
//                    `User.role` ('admin' / 'store' / 'user'),
//                    expressed as W1 roles for backward
//                    compatibility. Every existing account already
//                    implicitly holds exactly one of these.
// - QIFT roles     = operational / financial / compliance roles for
//                    QIFT staff. First eight names mirror
//                    apps/api/src/ops-roles/ops-roles.ts so the two
//                    catalogs can be unified later.
//                    `accountant_readonly` and `compliance_readonly`
//                    are new — they back the Stage 10 review-status
//                    surface (sign-off rights). `finance_admin` is
//                    the EXPANDED Stage 10 finance role (broader
//                    counterpart to the legacy-compatible `finance`
//                    role).
// - MERCHANT roles = per-merchant roles per FRP v1.1 § 9.6.3 +
//                    Stage 10 § 19 (W1). The backend `StoreGuard`
//                    gates on ownership rather than these roles
//                    today; the roles exist in the catalog for
//                    future use.
// - USER roles     = end-user roles. Only one for now
//                    (`user_standard`).
//
// BACKWARD COMPATIBILITY
// `legacyRoleFor(rawRole)` is the ONLY bridge between the legacy
// `User.role` string and this catalog. Every other code path should
// consume `Role` values directly.
//
// PARITY CONSTRAINT
// Every identifier in ROLES must match the frontend mirror at
// qift-ui-v2/lib/rbac/roles.ts byte-for-byte. The CI drift check
// enforces this.

// ---------------------------------------------------------------------
// LEGACY (backward-compat, derived from current User.role values)
// ---------------------------------------------------------------------

export const LEGACY_ROLES = [
  'legacy_admin',
  'legacy_store',
  'legacy_user',
] as const;

export type LegacyRole = (typeof LEGACY_ROLES)[number];

// ---------------------------------------------------------------------
// QIFT-SIDE (admin / operations / finance / compliance)
// First eight mirror apps/api/src/ops-roles/ops-roles.ts identically
// (same names, same permission scope). The last three are introduced
// here:
//   - accountant_readonly + compliance_readonly back the Stage 10
//     review-status surface (sign-off rights only).
//   - finance_admin is the EXPANDED Stage 10 finance role — it holds
//     reserves, financial-config, payout-overview, reject_payout,
//     and audit visibility on top of the legacy `finance` set. The
//     legacy `finance` role mirrors apps/api/src/ops-roles/ops-roles.ts
//     EXACTLY so that operators currently holding it never silently
//     gain new rights when a guard migrates from
//     `user.role === 'admin'` to a permission check. Promotion from
//     `finance` to `finance_admin` is an explicit assignment, never
//     automatic.
// ---------------------------------------------------------------------

export const QIFT_ROLES = [
  'super_admin',
  'operations_manager',
  'finance',
  'merchant_review',
  'support',
  'trust_safety',
  'fulfillment_ops',
  'analytics_viewer',
  'accountant_readonly',
  'compliance_readonly',
  'finance_admin',
] as const;

export type QiftRole = (typeof QIFT_ROLES)[number];

// ---------------------------------------------------------------------
// MERCHANT-SIDE
// FRP v1.1 § 9.6.3 + Stage 10 § 19 (W1).
// ---------------------------------------------------------------------

export const MERCHANT_ROLES = [
  'merchant_owner',
  'merchant_finance',
  'merchant_accountant_readonly',
  'merchant_manager',
  'merchant_staff',
  'merchant_owner_delegate',
] as const;

export type MerchantRole = (typeof MERCHANT_ROLES)[number];

// ---------------------------------------------------------------------
// USER-SIDE
// ---------------------------------------------------------------------

export const USER_ROLES = ['user_standard'] as const;

export type UserRole = (typeof USER_ROLES)[number];

// ---------------------------------------------------------------------
// UNION
// ---------------------------------------------------------------------

export type Role = LegacyRole | QiftRole | MerchantRole | UserRole;

export const ROLES: readonly Role[] = [
  ...LEGACY_ROLES,
  ...QIFT_ROLES,
  ...MERCHANT_ROLES,
  ...USER_ROLES,
];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------
// BACKWARD-COMPAT BRIDGE
// Derive the legacy W1 role from the current User.role field. This
// is the ONLY function that translates from the coarse `user.role`
// string to the catalog — every other code path should consume Role
// values directly.
//
// Unknown / undefined values fall back to legacy_user, matching the
// existing fallback behaviour of role-aware code.
// ---------------------------------------------------------------------

export function legacyRoleFor(rawRole: string | null | undefined): LegacyRole {
  switch (rawRole) {
    case 'admin':
      return 'legacy_admin';
    case 'store':
      return 'legacy_store';
    case 'user':
      return 'legacy_user';
    default:
      return 'legacy_user';
  }
}
