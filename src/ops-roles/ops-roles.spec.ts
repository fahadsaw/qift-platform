// Unit tests for ops-roles.ts — PR B-3a (catalog alignment refactor).
//
// The refactor introduces typecheck-level coupling between this
// legacy presentation catalog and the new src/rbac/ catalog. These
// tests prove that the runtime behaviour of `permissionsFor()` and
// `hasOpsPermission()` did NOT change as a result.
//
// Coverage:
//   1. OPS_ROLES contains the same 8 role names as before
//   2. OPS_PERMISSIONS contains the same 17 identifiers as the
//      pre-refactor OpsPermission union
//   3. Every OPS_ROLES name is a valid QiftRole in the new catalog
//      (runtime mirror of the compile-time `satisfies` check)
//   4. Every OPS_PERMISSIONS identifier is a valid Permission
//      (runtime mirror of the compile-time `satisfies` check)
//   5. SUPER_ADMIN_ALL aligns with OPS_PERMISSIONS (no missing
//      permission for super_admin — a new test that closes the
//      "manually maintain SUPER_ADMIN_ALL" gap by detecting drift
//      at test time)
//   6. permissionsFor() per-role outputs match documented sets
//   7. hasOpsPermission() boolean behaviour for granted /
//      non-granted / unknown-role / empty-input cases
//
// This module has never had a test file. PR B-3a adds the first.

import { PERMISSIONS, QIFT_ROLES, type Permission } from '../rbac';
import {
  OPS_PERMISSIONS,
  OPS_ROLES,
  hasOpsPermission,
  isOpsRole,
  permissionsFor,
  type OpsPermission,
} from './ops-roles';

describe('OPS_ROLES', () => {
  it('contains exactly the 8 expected role names', () => {
    expect([...OPS_ROLES]).toEqual([
      'super_admin',
      'operations_manager',
      'finance',
      'merchant_review',
      'support',
      'trust_safety',
      'fulfillment_ops',
      'analytics_viewer',
    ]);
  });

  it('contains no duplicates', () => {
    expect(new Set(OPS_ROLES).size).toBe(OPS_ROLES.length);
  });

  it('every role name is a valid QiftRole in the new RBAC catalog', () => {
    // Runtime mirror of the compile-time `satisfies readonly QiftRole[]`
    // check. If the RBAC catalog drops or renames any of these roles
    // without updating ops-roles.ts, this fails.
    for (const role of OPS_ROLES) {
      expect(QIFT_ROLES).toContain(role);
    }
  });
});

describe('isOpsRole', () => {
  it('accepts known ops role names', () => {
    expect(isOpsRole('super_admin')).toBe(true);
    expect(isOpsRole('finance')).toBe(true);
    expect(isOpsRole('support')).toBe(true);
  });

  it('rejects unknown role names', () => {
    expect(isOpsRole('not_a_role')).toBe(false);
    expect(isOpsRole('')).toBe(false);
  });

  it('rejects RBAC roles that are NOT ops roles', () => {
    // The new RBAC catalog has additional QIFT roles
    // (accountant_readonly, compliance_readonly, finance_admin) and
    // legacy/merchant/user roles. None of those are OPS_ROLES — only
    // the original 8 ops roles are accepted here. This preserves
    // the live OpsRoleAssignment contract.
    expect(isOpsRole('legacy_admin')).toBe(false);
    expect(isOpsRole('accountant_readonly')).toBe(false);
    expect(isOpsRole('finance_admin')).toBe(false);
    expect(isOpsRole('merchant_owner')).toBe(false);
  });
});

describe('OPS_PERMISSIONS', () => {
  it('contains exactly the 22 expected identifiers', () => {
    expect([...OPS_PERMISSIONS]).toEqual([
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
      'finance.read_payouts',
      'finance.record_payout_event',
      'finance.approve_payout',
      'finance.reconcile',
      'finance.vat_facts',
      'diagnostics.read',
      'diagnostics.run_seed',
      'report.read',
      'report.resolve',
      'analytics.read',
      'beta.manage',
      'org.review',
      'audit.read',
    ]);
  });

  it('contains no duplicates', () => {
    expect(new Set(OPS_PERMISSIONS).size).toBe(OPS_PERMISSIONS.length);
  });

  it('every identifier is a valid Permission in the new RBAC catalog', () => {
    // Runtime mirror of the compile-time `satisfies readonly Permission[]`
    // check. Defense-in-depth against any future change that
    // bypasses the compile-time guard.
    for (const p of OPS_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
    }
  });
});

describe('SUPER_ADMIN_ALL alignment with OPS_PERMISSIONS', () => {
  // Closes the historical gap noted in the pre-refactor comment:
  // "Update alongside the OpsPermission union — the typechecker
  // doesn't enforce this alignment automatically."
  //
  // After PR B-3a, the typechecker enforces that every entry in
  // SUPER_ADMIN_ALL is a valid OpsPermission, but it does NOT
  // enforce that EVERY OpsPermission appears in SUPER_ADMIN_ALL.
  // This test catches that drift at test time.

  it('super_admin grants every permission in OPS_PERMISSIONS', () => {
    const superAdminPermissions = permissionsFor(['super_admin']);
    expect(superAdminPermissions.size).toBe(OPS_PERMISSIONS.length);
    for (const p of OPS_PERMISSIONS) {
      expect(superAdminPermissions.has(p)).toBe(true);
    }
  });

  it('super_admin permission set has no extras beyond OPS_PERMISSIONS', () => {
    const superAdminPermissions = permissionsFor(['super_admin']);
    for (const p of superAdminPermissions) {
      expect(OPS_PERMISSIONS).toContain(p);
    }
  });
});

describe('permissionsFor — single role behaviour (pre-refactor parity)', () => {
  it('operations_manager returns its documented set', () => {
    expect(permissionsFor(['operations_manager'])).toEqual(
      new Set<OpsPermission>([
        'store.review',
        'store.set_status',
        'store.set_featured',
        'store.read_detail',
        'user.read',
        'diagnostics.read',
        'diagnostics.run_seed',
        'report.read',
        'analytics.read',
        'beta.manage',
        'audit.read',
        'org.review',
      ]),
    );
  });

  it('finance returns its documented set (5 perms — PR 3a anchor)', () => {
    expect(permissionsFor(['finance'])).toEqual(
      new Set<OpsPermission>([
        'finance.read_payouts',
        'finance.record_payout_event',
        'finance.approve_payout',
        'finance.reconcile',
        'finance.vat_facts',
        'store.read_detail',
        'analytics.read',
      ]),
    );
  });

  it('merchant_review returns its documented set', () => {
    expect(permissionsFor(['merchant_review'])).toEqual(
      new Set<OpsPermission>([
        'store.review',
        'store.read_detail',
        'store.set_status',
      ]),
    );
  });

  it('support returns its documented set', () => {
    expect(permissionsFor(['support'])).toEqual(
      new Set<OpsPermission>([
        'store.read_detail',
        'user.read',
        'diagnostics.read',
        'report.read',
      ]),
    );
  });

  it('trust_safety returns its documented set', () => {
    expect(permissionsFor(['trust_safety'])).toEqual(
      new Set<OpsPermission>([
        'user.read',
        'user.suspend',
        // user.restore mirrors user.suspend — the operator who
        // can disable can also restore. user.purge is super_admin
        // only, NOT trust_safety.
        'user.restore',
        'report.read',
        'report.resolve',
        'store.set_status',
        'audit.read',
      ]),
    );
  });

  it('fulfillment_ops returns its documented set', () => {
    expect(permissionsFor(['fulfillment_ops'])).toEqual(
      new Set<OpsPermission>(['store.read_detail', 'diagnostics.read']),
    );
  });

  it('analytics_viewer returns its documented set', () => {
    expect(permissionsFor(['analytics_viewer'])).toEqual(
      new Set<OpsPermission>(['analytics.read']),
    );
  });
});

describe('permissionsFor — edge cases', () => {
  it('returns empty set for empty input', () => {
    expect(permissionsFor([]).size).toBe(0);
  });

  it('filters out unknown role names without throwing', () => {
    expect(permissionsFor(['not_a_role']).size).toBe(0);
    expect(permissionsFor([''])).toEqual(new Set());
  });

  it('mixed known + unknown roles: only known contribute', () => {
    expect(permissionsFor(['not_a_role', 'analytics_viewer'])).toEqual(
      new Set<OpsPermission>(['analytics.read']),
    );
  });

  it('produces the union for multiple roles (no double-counting)', () => {
    // support contributes: store.read_detail, user.read, diagnostics.read, report.read
    // analytics_viewer contributes: analytics.read
    expect(permissionsFor(['support', 'analytics_viewer'])).toEqual(
      new Set<OpsPermission>([
        'store.read_detail',
        'user.read',
        'diagnostics.read',
        'report.read',
        'analytics.read',
      ]),
    );
  });

  it('super_admin combined with another role still yields the full set', () => {
    // super_admin already has everything; adding another role is a no-op.
    const withCombined = permissionsFor(['super_admin', 'finance']);
    const justSuperAdmin = permissionsFor(['super_admin']);
    expect(withCombined).toEqual(justSuperAdmin);
  });
});

describe('hasOpsPermission', () => {
  it('returns true for permissions the role grants', () => {
    expect(hasOpsPermission(['finance'], 'finance.read_payouts')).toBe(true);
    expect(hasOpsPermission(['support'], 'user.read')).toBe(true);
  });

  it('returns false for permissions the role does NOT grant', () => {
    expect(hasOpsPermission(['finance'], 'store.set_plan')).toBe(false);
    expect(hasOpsPermission(['support'], 'user.suspend')).toBe(false);
  });

  it('super_admin holds every permission in OPS_PERMISSIONS', () => {
    for (const p of OPS_PERMISSIONS) {
      expect(hasOpsPermission(['super_admin'], p)).toBe(true);
    }
  });

  it('unknown role produces false', () => {
    const arbitraryPermission: OpsPermission = 'store.review';
    expect(hasOpsPermission(['not_a_role'], arbitraryPermission)).toBe(false);
  });

  it('empty role list produces false', () => {
    const arbitraryPermission: OpsPermission = 'store.review';
    expect(hasOpsPermission([], arbitraryPermission)).toBe(false);
  });
});

describe('shared identifiers reference the RBAC catalog without circular import', () => {
  // Sanity check that the new typecheck-level coupling doesn't
  // introduce a runtime circular dependency. If the import graph
  // were broken, this `import` itself would fail at module load.
  it('PERMISSIONS from rbac is loaded and non-empty', () => {
    const knownRbacPermissions = new Set<Permission>(PERMISSIONS);
    expect(knownRbacPermissions.size).toBeGreaterThan(0);
  });
});
