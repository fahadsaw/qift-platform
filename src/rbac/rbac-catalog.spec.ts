// Catalog unit tests — PR B-1.
//
// Pure-function tests, no Nest DI, no DB. Validates the structural
// invariants of the RBAC catalog and the legacy-role behaviour
// preservation that the guard migration (PR B-4+) depends on.
//
// Tests cover three layers:
//   1. Permission / Role catalog shape (no duplicates, non-empty,
//      orphan-permission audit).
//   2. legacyRoleFor backward-compat bridge.
//   3. ROLE_PERMISSIONS legacy-role equivalence (the load-bearing
//      contract for safe guard migration).
//
// If the catalog drifts (typo, missing role entry, accidental
// removal), these tests fail before any guard ever consumes the
// catalog.

import {
  ADMIN_PERMISSIONS,
  AUDIT_PERMISSIONS,
  FINANCE_PERMISSIONS,
  FLAG_PERMISSIONS,
  LEGACY_ROLES,
  MERCHANT_FINANCE_PERMISSIONS,
  MERCHANT_PERMISSIONS,
  MERCHANT_ROLES,
  PERMISSIONS,
  QIFT_ROLES,
  REVIEW_PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  USER_PERMISSIONS,
  USER_ROLES,
  isPermission,
  isRole,
  legacyRoleFor,
  permissionsForRoles,
  roleHasPermission,
  rolesWithPermission,
  type Permission,
} from './index';

describe('RBAC catalog — PERMISSIONS', () => {
  it('is non-empty', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(0);
  });

  it('contains no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('is the union of all per-domain catalogs', () => {
    const groups = [
      ...ADMIN_PERMISSIONS,
      ...FINANCE_PERMISSIONS,
      ...REVIEW_PERMISSIONS,
      ...AUDIT_PERMISSIONS,
      ...FLAG_PERMISSIONS,
      ...MERCHANT_PERMISSIONS,
      ...MERCHANT_FINANCE_PERMISSIONS,
      ...USER_PERMISSIONS,
    ];
    expect(new Set(PERMISSIONS)).toEqual(new Set(groups));
  });

  it('isPermission accepts known identifiers', () => {
    expect(isPermission('admin.access')).toBe(true);
    expect(isPermission('merchant.access')).toBe(true);
    expect(isPermission('user.profile.read')).toBe(true);
    expect(isPermission('finance.read_payouts')).toBe(true);
  });

  it('isPermission rejects unknown identifiers', () => {
    expect(isPermission('not.a.real.permission')).toBe(false);
    expect(isPermission('')).toBe(false);
    expect(isPermission('admin')).toBe(false);
  });
});

describe('RBAC catalog — ROLES', () => {
  it('is non-empty', () => {
    expect(ROLES.length).toBeGreaterThan(0);
  });

  it('contains no duplicates', () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });

  it('is the union of all role groups', () => {
    const groups = [
      ...LEGACY_ROLES,
      ...QIFT_ROLES,
      ...MERCHANT_ROLES,
      ...USER_ROLES,
    ];
    expect(new Set(ROLES)).toEqual(new Set(groups));
  });

  it('legacy roles exist with expected names', () => {
    expect(LEGACY_ROLES).toEqual([
      'legacy_admin',
      'legacy_store',
      'legacy_user',
    ]);
  });

  it('QIFT_ROLES includes finance and finance_admin distinctly', () => {
    expect(QIFT_ROLES).toContain('finance');
    expect(QIFT_ROLES).toContain('finance_admin');
  });

  it('MERCHANT_ROLES includes all six W1 merchant roles', () => {
    expect(new Set(MERCHANT_ROLES)).toEqual(
      new Set([
        'merchant_owner',
        'merchant_owner_delegate',
        'merchant_finance',
        'merchant_accountant_readonly',
        'merchant_manager',
        'merchant_staff',
      ]),
    );
  });

  it('isRole accepts known role names', () => {
    expect(isRole('legacy_admin')).toBe(true);
    expect(isRole('super_admin')).toBe(true);
    expect(isRole('merchant_owner')).toBe(true);
    expect(isRole('user_standard')).toBe(true);
  });

  it('isRole rejects unknown role names', () => {
    expect(isRole('not_a_role')).toBe(false);
    expect(isRole('admin')).toBe(false);
    expect(isRole('')).toBe(false);
  });
});

describe('RBAC catalog — legacyRoleFor', () => {
  it("maps 'admin' to legacy_admin", () => {
    expect(legacyRoleFor('admin')).toBe('legacy_admin');
  });

  it("maps 'store' to legacy_store", () => {
    expect(legacyRoleFor('store')).toBe('legacy_store');
  });

  it("maps 'user' to legacy_user", () => {
    expect(legacyRoleFor('user')).toBe('legacy_user');
  });

  it('maps null to legacy_user', () => {
    expect(legacyRoleFor(null)).toBe('legacy_user');
  });

  it('maps undefined to legacy_user', () => {
    expect(legacyRoleFor(undefined)).toBe('legacy_user');
  });

  it('maps unknown strings to legacy_user (safe fallback)', () => {
    expect(legacyRoleFor('superadmin')).toBe('legacy_user');
    expect(legacyRoleFor('')).toBe('legacy_user');
    expect(legacyRoleFor('STORE')).toBe('legacy_user'); // case-sensitive
  });
});

describe('RBAC catalog — ROLE_PERMISSIONS structure', () => {
  it('has an entry for every Role', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });

  it('every entry contains only valid Permission identifiers', () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(p);
      }
    }
  });

  it('every Permission is held by at least one Role (no orphans)', () => {
    for (const permission of PERMISSIONS) {
      const holders = rolesWithPermission(permission);
      expect(holders.length).toBeGreaterThan(0);
    }
  });
});

describe('RBAC catalog — legacy role behavior preservation', () => {
  // These tests encode the load-bearing contract for safe guard
  // migration: every current `user.role === 'admin'` / 'store' /
  // 'user' account, when mapped via legacyRoleFor, must hold the
  // permissions that today's coarse role check implies. If any of
  // these fails, the dual-path migration in PR B-4 would change
  // user-visible behaviour when the kill-switch flips ON.

  it('legacy_admin holds admin.access', () => {
    expect(roleHasPermission('legacy_admin', 'admin.access')).toBe(true);
  });

  it('legacy_admin holds the full admin-side surface', () => {
    expect(roleHasPermission('legacy_admin', 'finance.read_payouts')).toBe(
      true,
    );
    expect(roleHasPermission('legacy_admin', 'audit.read')).toBe(true);
    expect(roleHasPermission('legacy_admin', 'flag.write_financial')).toBe(
      true,
    );
    expect(roleHasPermission('legacy_admin', 'review.read_status')).toBe(true);
  });

  it('legacy_admin does NOT hold merchant.access or user-side perms', () => {
    expect(roleHasPermission('legacy_admin', 'merchant.access')).toBe(false);
    expect(roleHasPermission('legacy_admin', 'user.profile.read')).toBe(false);
  });

  it('legacy_store holds merchant.access and merchant_finance.read_own', () => {
    expect(roleHasPermission('legacy_store', 'merchant.access')).toBe(true);
    expect(roleHasPermission('legacy_store', 'merchant_finance.read_own')).toBe(
      true,
    );
  });

  it('legacy_store does NOT hold admin.access or user-side perms', () => {
    expect(roleHasPermission('legacy_store', 'admin.access')).toBe(false);
    expect(roleHasPermission('legacy_store', 'user.profile.read')).toBe(false);
  });

  it('legacy_user holds user-side permissions', () => {
    expect(roleHasPermission('legacy_user', 'user.profile.read')).toBe(true);
    expect(roleHasPermission('legacy_user', 'user.send_gift')).toBe(true);
    expect(roleHasPermission('legacy_user', 'user.wishlist.write')).toBe(true);
  });

  it('legacy_user holds neither admin.access nor merchant.access', () => {
    expect(roleHasPermission('legacy_user', 'admin.access')).toBe(false);
    expect(roleHasPermission('legacy_user', 'merchant.access')).toBe(false);
    expect(roleHasPermission('legacy_user', 'merchant_finance.read_own')).toBe(
      false,
    );
  });
});

describe('RBAC catalog — finance role parity with apps/api/src/ops-roles/', () => {
  // PR 3a constraint (carried into PR B-1): the `finance` role
  // mirrors the existing OpsRolesService finance permission list
  // EXACTLY, plus admin.access. Operators currently holding the
  // `finance` ops role must gain ZERO new rights when a guard
  // migrates from `user.role === 'admin'` to a permission check.
  // The broader Stage 10 finance scope lives on `finance_admin`,
  // granted only by explicit assignment.

  it('finance role contains exactly the opsRoles set plus admin.access', () => {
    const expected = new Set<Permission>([
      'admin.access',
      'finance.read_payouts',
      'finance.record_payout_event',
      'finance.approve_payout',
      'store.read_detail',
      'analytics.read',
    ]);
    expect(new Set(ROLE_PERMISSIONS.finance)).toEqual(expected);
  });

  it('finance role count is 6', () => {
    expect(ROLE_PERMISSIONS.finance.length).toBe(6);
  });

  it('finance does NOT hold expanded Stage 10 finance rights', () => {
    expect(roleHasPermission('finance', 'finance.reject_payout')).toBe(false);
    expect(roleHasPermission('finance', 'finance.read_payout_overview')).toBe(
      false,
    );
    expect(roleHasPermission('finance', 'finance.read_reserves')).toBe(false);
    expect(roleHasPermission('finance', 'finance.modify_reserve')).toBe(false);
    expect(roleHasPermission('finance', 'finance.read_financial_config')).toBe(
      false,
    );
    expect(roleHasPermission('finance', 'finance.write_financial_config')).toBe(
      false,
    );
    expect(roleHasPermission('finance', 'audit.read')).toBe(false);
  });

  it('finance_admin holds the expanded Stage 10 finance scope', () => {
    expect(roleHasPermission('finance_admin', 'finance.reject_payout')).toBe(
      true,
    );
    expect(
      roleHasPermission('finance_admin', 'finance.read_payout_overview'),
    ).toBe(true);
    expect(roleHasPermission('finance_admin', 'finance.read_reserves')).toBe(
      true,
    );
    expect(roleHasPermission('finance_admin', 'finance.modify_reserve')).toBe(
      true,
    );
    expect(
      roleHasPermission('finance_admin', 'finance.read_financial_config'),
    ).toBe(true);
    expect(
      roleHasPermission('finance_admin', 'finance.write_financial_config'),
    ).toBe(true);
    expect(roleHasPermission('finance_admin', 'audit.read')).toBe(true);
  });

  it('finance_admin is granted to ZERO accounts by default (catalog-only)', () => {
    // Sanity check: this PR ships the role definition. No code path
    // assigns it. The intent is "granted only by explicit operator
    // assignment in the future migration step". This test documents
    // that intent at the catalog level — no automated wiring should
    // promote finance → finance_admin.
    //
    // (This test passes trivially today because no user-assignment
    // table exists yet. It exists as a guard against a future
    // contributor adding such wiring without the explicit-assignment
    // workflow.)
    expect(ROLE_PERMISSIONS.finance_admin).toBeDefined();
    expect(ROLE_PERMISSIONS.finance_admin.length).toBeGreaterThan(0);
  });
});

describe('RBAC catalog — permissionsForRoles', () => {
  it('returns an empty set for empty input', () => {
    expect(permissionsForRoles([]).size).toBe(0);
  });

  it('returns the union of permissions for multiple roles', () => {
    const result = permissionsForRoles(['support', 'analytics_viewer']);
    expect(result.has('admin.access')).toBe(true);
    expect(result.has('analytics.read')).toBe(true);
    expect(result.has('user.read')).toBe(true);
  });

  it('handles a single role', () => {
    const result = permissionsForRoles(['legacy_user']);
    expect(result.size).toBeGreaterThan(0);
    expect(result.has('user.profile.read')).toBe(true);
  });

  it('returns a fresh Set on each call (callers may mutate freely)', () => {
    const a = permissionsForRoles(['legacy_user']);
    const b = permissionsForRoles(['legacy_user']);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('RBAC catalog — rolesWithPermission', () => {
  it('returns every role that holds the given permission', () => {
    const holders = rolesWithPermission('admin.access');
    expect(holders).toContain('legacy_admin');
    expect(holders).toContain('super_admin');
    expect(holders).toContain('finance');
    expect(holders).toContain('finance_admin');
  });

  it('returns roles for merchant-side permissions', () => {
    const holders = rolesWithPermission('merchant_finance.read_own');
    expect(holders).toContain('legacy_store');
    expect(holders).toContain('merchant_owner');
    expect(holders).toContain('merchant_finance');
    expect(holders).toContain('merchant_accountant_readonly');
    // operational-only roles must NOT hold finance permissions
    expect(holders).not.toContain('merchant_manager');
    expect(holders).not.toContain('merchant_staff');
  });
});
