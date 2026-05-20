// RBAC catalog — code-only foundation for the unified W1 permission
// system (backend mirror).
//
// THIS MODULE IS UNWIRED.
// Nothing in here is consumed by production authorization yet.
// Existing authorization continues to flow through the coarse
// `User.role` field and the legacy presentation catalog at
// apps/api/src/ops-roles/ops-roles.ts. PR B-2 introduces
// `hasPermission(user, perm)`; PR B-3 introduces the kill-switch
// flag; PR B-4+ migrate guards behind the flag.
//
// PURPOSE OF PR B-1
// Lay down the catalog on the backend so the target shape is
// reviewable and referenceable, without changing any current
// authorization behaviour. Unit tests landed alongside ensure the
// catalog's structural invariants hold and the legacy role
// behaviour is preserved by the new shape.
//
// LAYOUT
// - permissions.ts  — every named Permission, grouped by domain
// - roles.ts        — every named Role (legacy + QIFT + merchant +
//                     user), plus the backward-compat bridge
//                     `legacyRoleFor()`
// - role-map.ts     — Record<Role, readonly Permission[]> with
//                     helpers
//
// RELATIONSHIP TO apps/api/src/ops-roles/
// apps/api/src/ops-roles/ops-roles.ts is the existing presentation
// catalog mirroring the backend ops-roles service. Its role names +
// permission strings are a subset of what's exported here. PR B-3a
// will refactor that module to satisfy `readonly Permission[]` from
// this catalog, eliminating drift on shared identifiers (same
// pattern as frontend PR 3b).
//
// PARITY WITH FRONTEND
// Every identifier in PERMISSIONS and ROLES must match the frontend
// mirror at qift-ui-v2/lib/rbac/ byte-for-byte. CI drift check
// (PR B-0b, vendored-snapshot approach) enforces this.

export {
  ADMIN_PERMISSIONS,
  FINANCE_PERMISSIONS,
  REVIEW_PERMISSIONS,
  AUDIT_PERMISSIONS,
  FLAG_PERMISSIONS,
  MERCHANT_PERMISSIONS,
  MERCHANT_FINANCE_PERMISSIONS,
  USER_PERMISSIONS,
  PERMISSIONS,
  isPermission,
  type Permission,
  type AdminPermission,
  type FinancePermission,
  type ReviewPermission,
  type AuditPermission,
  type FlagPermission,
  type MerchantPermission,
  type MerchantFinancePermission,
  type UserPermission,
} from './permissions';

export {
  LEGACY_ROLES,
  QIFT_ROLES,
  MERCHANT_ROLES,
  USER_ROLES,
  ROLES,
  isRole,
  legacyRoleFor,
  type Role,
  type LegacyRole,
  type QiftRole,
  type MerchantRole,
  type UserRole,
} from './roles';

export {
  ROLE_PERMISSIONS,
  permissionsForRoles,
  roleHasPermission,
  rolesWithPermission,
} from './role-map';

export {
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  permissionsForUser,
  type UserLike,
} from './has-permission';

export { arePermissionChecksEnabled } from './permission-checks-flag';
