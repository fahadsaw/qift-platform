// User-level permission checks — the only RBAC helpers that take a
// User-shaped input (backend mirror of qift-ui-v2/lib/rbac/hasPermission.ts).
//
// CONTRACT
// `hasPermission(user, perm)` answers the question "is this user
// allowed to do X?" by:
//   1. reading `user.role` (the current coarse string field on the
//      Prisma User row),
//   2. mapping it through `legacyRoleFor()` to a `LegacyRole`, and
//   3. consulting the PR B-1 role → permission catalog.
//
// This preserves current behaviour EXACTLY for every account:
//   user.role === 'admin' → legacy_admin → every admin permission
//   user.role === 'store' → legacy_store → every merchant permission
//   user.role === 'user'  → legacy_user  → every user permission
//   null / undefined / unknown → legacy_user (safe fallback)
//
// BACKWARD COMPATIBILITY
// This helper is the ONE chokepoint where the legacy `User.role`
// string is translated into RBAC checks. When `UserRoleAssignment`
// lands in a later phase, this function will gain a second branch:
// "use assignments if present, otherwise fall back to legacyRoleFor".
// Until then, the legacy mapping is the only behaviour.
//
// NOT WIRED YET
// No guard, no controller, no service reads from this module yet.
// PR B-2 ships the helper; PR B-3 ships the kill-switch flag; PR B-4
// is the first guard migration that consumes both.
//
// STRUCTURAL INPUT TYPE
// Accepts `UserLike` (`{ role?: string | null }`) so callers can pass
// a Prisma `User` row, a partial DTO, or a mock. The Prisma `User`
// type satisfies `UserLike` (see drift guard at the bottom of this
// file).

import { type Permission } from './permissions';
import { legacyRoleFor } from './roles';
import { permissionsForRoles, roleHasPermission } from './role-map';

// Structural input type. Anything with an optional `role` string is
// accepted — a Prisma User row satisfies this, as do DTOs, mocks, or
// session payloads that carry only the role field.
export type UserLike = { role?: string | null };

// True iff the given user holds the given permission.
//
// Falsy users (null / undefined) are treated as anonymous and resolve
// to legacy_user permissions. This means callers don't need to
// null-check before calling — passing `null` is safe and returns the
// user-tier answer.
export function hasPermission(
  user: UserLike | null | undefined,
  permission: Permission,
): boolean {
  const role = legacyRoleFor(user?.role);
  return roleHasPermission(role, permission);
}

// True iff the given user holds AT LEAST ONE of the given permissions.
// Empty array returns false (vacuous "any of nothing" is false).
//
// Builds the user's permission set once, so this is cheaper than
// calling `hasPermission` in a loop when checking multiple options.
export function hasAnyPermission(
  user: UserLike | null | undefined,
  permissions: readonly Permission[],
): boolean {
  if (permissions.length === 0) return false;
  const set = permissionsForUser(user);
  for (const p of permissions) {
    if (set.has(p)) return true;
  }
  return false;
}

// True iff the given user holds EVERY one of the given permissions.
// Empty array returns true (vacuous "all of nothing" is true).
export function hasAllPermissions(
  user: UserLike | null | undefined,
  permissions: readonly Permission[],
): boolean {
  if (permissions.length === 0) return true;
  const set = permissionsForUser(user);
  for (const p of permissions) {
    if (!set.has(p)) return false;
  }
  return true;
}

// All permissions held by the given user. Returns a fresh Set on
// every call — callers may mutate it freely. Intended for batch
// checks and "what can this user do?" debug surfaces.
export function permissionsForUser(
  user: UserLike | null | undefined,
): Set<Permission> {
  const role = legacyRoleFor(user?.role);
  return permissionsForRoles([role]);
}

// ---------------------------------------------------------------------
// Compile-time drift guard — STRUCTURAL ONLY.
//
// Prisma generates `role: string` for User (not a literal union — the
// schema uses a `String` column, not an enum). The frontend's strict
// bidirectional equality check against `AuthUser['role']` cannot be
// replicated here because the literal union doesn't exist at the type
// level on the backend.
//
// What this check DOES guarantee:
//   - Prisma's User type continues to have a `role` field
//   - That `role` field is structurally compatible with `string |
//     null | undefined` (so the helper's input shape stays valid)
//
// What this check does NOT guarantee:
//   - The documented role enum ('user' / 'store' / 'admin') matches
//     what legacyRoleFor handles. The enum is encoded in the
//     prisma/schema.prisma User.role comment and in the
//     legacyRoleFor switch; keeping them in sync is a manual
//     maintenance step. The catalog tests in rbac-catalog.spec.ts
//     cover the legacyRoleFor side at test time.
//
// If Prisma's User type loses the `role` field, or `role` becomes
// incompatible with `string`, the assignment below fails to compile.
// ---------------------------------------------------------------------

import type { User } from '@prisma/client';

type _PrismaUserSatisfiesUserLike = User extends UserLike ? true : never;

// Anchors the type-level check at module load. The `void` expression
// consumes the binding so ESLint's no-unused-vars rule passes.
const _prismaUserDriftOk: _PrismaUserSatisfiesUserLike = true;
void _prismaUserDriftOk;
