// Unit tests for has-permission.ts — PR B-2.
//
// Pure-function tests, no Nest DI, no DB. Validates that:
//   1. hasPermission resolves user.role → legacyRoleFor → catalog
//   2. Falsy / unknown role inputs fall back safely to legacy_user
//   3. legacy_admin / legacy_store / legacy_user behaviour matches
//      what today's `user.role === 'admin'` style checks produce —
//      the load-bearing contract for safe AdminGuard migration (PR B-4)
//   4. hasAnyPermission / hasAllPermissions edge cases (empty array
//      vacuous-truth semantics, set-based optimization correctness)
//
// These tests overlap intentionally with rbac-catalog.spec.ts on
// legacy-role expectations — the catalog tests assert the SHAPE of
// ROLE_PERMISSIONS, while these tests assert the HELPER routes
// user-shaped inputs through that shape correctly.

import {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permissionsForUser,
} from './index';

describe('hasPermission', () => {
  describe('admin user (user.role === "admin")', () => {
    const admin = { role: 'admin' };

    it('grants admin.access', () => {
      expect(hasPermission(admin, 'admin.access')).toBe(true);
    });

    it('grants the full admin-side surface', () => {
      expect(hasPermission(admin, 'finance.read_payouts')).toBe(true);
      expect(hasPermission(admin, 'finance.write_financial_config')).toBe(true);
      expect(hasPermission(admin, 'audit.read')).toBe(true);
      expect(hasPermission(admin, 'audit.export')).toBe(true);
      expect(hasPermission(admin, 'flag.write_financial')).toBe(true);
      expect(hasPermission(admin, 'review.sign_off_accountant')).toBe(true);
    });

    it('does NOT grant merchant.access (admin-side ≠ merchant-side)', () => {
      expect(hasPermission(admin, 'merchant.access')).toBe(false);
    });

    it('does NOT grant user-side permissions', () => {
      expect(hasPermission(admin, 'user.profile.read')).toBe(false);
      expect(hasPermission(admin, 'user.send_gift')).toBe(false);
    });
  });

  describe('store user (user.role === "store")', () => {
    const store = { role: 'store' };

    it('grants merchant.access', () => {
      expect(hasPermission(store, 'merchant.access')).toBe(true);
    });

    it('grants merchant_finance.read_own (matches canViewMerchantFinance)', () => {
      expect(hasPermission(store, 'merchant_finance.read_own')).toBe(true);
    });

    it('grants the full merchant-side surface', () => {
      expect(hasPermission(store, 'merchant.products.write')).toBe(true);
      expect(hasPermission(store, 'merchant.orders.write')).toBe(true);
      expect(hasPermission(store, 'merchant.team.write')).toBe(true);
    });

    it('does NOT grant admin.access', () => {
      expect(hasPermission(store, 'admin.access')).toBe(false);
    });

    it('does NOT grant user-side permissions', () => {
      expect(hasPermission(store, 'user.profile.read')).toBe(false);
    });
  });

  describe('regular user (user.role === "user")', () => {
    const user = { role: 'user' };

    it('grants user-side permissions', () => {
      expect(hasPermission(user, 'user.profile.read')).toBe(true);
      expect(hasPermission(user, 'user.send_gift')).toBe(true);
      expect(hasPermission(user, 'user.wishlist.write')).toBe(true);
    });

    it('does NOT grant admin.access', () => {
      expect(hasPermission(user, 'admin.access')).toBe(false);
    });

    it('does NOT grant merchant.access', () => {
      expect(hasPermission(user, 'merchant.access')).toBe(false);
    });
  });

  describe('null / undefined user', () => {
    it('returns false for admin-side permissions', () => {
      expect(hasPermission(null, 'admin.access')).toBe(false);
      expect(hasPermission(undefined, 'admin.access')).toBe(false);
    });

    it('returns false for merchant-side permissions', () => {
      expect(hasPermission(null, 'merchant.access')).toBe(false);
      expect(hasPermission(undefined, 'merchant.access')).toBe(false);
    });

    it('returns true for user-side permissions (legacy_user fallback)', () => {
      // The fallback to legacy_user grants user permissions to
      // anonymous callers. This is intentional and matches the
      // frontend behaviour — anonymous viewing of user surfaces is
      // mediated by route-level auth guards, not RBAC.
      expect(hasPermission(null, 'user.profile.read')).toBe(true);
      expect(hasPermission(undefined, 'user.send_gift')).toBe(true);
    });
  });

  describe('unknown role fallback', () => {
    it('treats unknown roles as legacy_user', () => {
      expect(hasPermission({ role: 'superadmin' }, 'admin.access')).toBe(false);
      expect(hasPermission({ role: '' }, 'admin.access')).toBe(false);
      expect(hasPermission({ role: 'STORE' }, 'merchant.access')).toBe(false); // case-sensitive
    });

    it('treats null role as legacy_user', () => {
      expect(hasPermission({ role: null }, 'admin.access')).toBe(false);
      expect(hasPermission({ role: null }, 'user.profile.read')).toBe(true);
    });

    it('treats missing role property as legacy_user', () => {
      expect(hasPermission({}, 'admin.access')).toBe(false);
      expect(hasPermission({}, 'user.profile.read')).toBe(true);
    });
  });

  describe('Prisma User compatibility', () => {
    // Structural compatibility check — passing a minimal object
    // shaped like a Prisma User row works (the type-level drift
    // guard at the bottom of has-permission.ts ensures this).
    it('accepts a Prisma-shaped object', () => {
      const prismaUser = {
        id: 'cuid_xxx',
        fullName: null,
        phone: '+966500000000',
        email: null,
        qiftUsername: 'test',
        passwordHash: null,
        defaultAddress: null,
        phoneVerifiedAt: null,
        emailVerifiedAt: null,
        role: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      expect(hasPermission(prismaUser, 'admin.access')).toBe(true);
    });
  });
});

describe('hasAnyPermission', () => {
  const admin = { role: 'admin' };
  const user = { role: 'user' };

  it('returns false for an empty permission list (vacuous "any of nothing")', () => {
    expect(hasAnyPermission(admin, [])).toBe(false);
    expect(hasAnyPermission(user, [])).toBe(false);
    expect(hasAnyPermission(null, [])).toBe(false);
  });

  it('returns true when at least one permission is held', () => {
    expect(hasAnyPermission(admin, ['admin.access', 'merchant.access'])).toBe(
      true,
    );
    expect(hasAnyPermission(user, ['admin.access', 'user.profile.read'])).toBe(
      true,
    );
  });

  it('returns false when none of the permissions are held', () => {
    expect(hasAnyPermission(user, ['admin.access', 'merchant.access'])).toBe(
      false,
    );
    expect(hasAnyPermission(null, ['admin.access', 'merchant.access'])).toBe(
      false,
    );
  });

  it('handles a single-element permission list', () => {
    expect(hasAnyPermission(admin, ['admin.access'])).toBe(true);
    expect(hasAnyPermission(user, ['admin.access'])).toBe(false);
  });
});

describe('hasAllPermissions', () => {
  const admin = { role: 'admin' };
  const user = { role: 'user' };

  it('returns true for an empty permission list (vacuous "all of nothing")', () => {
    expect(hasAllPermissions(admin, [])).toBe(true);
    expect(hasAllPermissions(user, [])).toBe(true);
    expect(hasAllPermissions(null, [])).toBe(true);
  });

  it('returns true when every permission is held', () => {
    expect(
      hasAllPermissions(admin, [
        'admin.access',
        'finance.read_payouts',
        'audit.read',
      ]),
    ).toBe(true);
  });

  it('returns false when any permission is missing', () => {
    expect(hasAllPermissions(admin, ['admin.access', 'merchant.access'])).toBe(
      false,
    );
    expect(hasAllPermissions(user, ['user.profile.read', 'admin.access'])).toBe(
      false,
    );
  });

  it('returns false for null user when permission list is non-empty admin-side', () => {
    expect(hasAllPermissions(null, ['admin.access'])).toBe(false);
  });
});

describe('permissionsForUser', () => {
  it('returns a non-empty set for admin user', () => {
    const result = permissionsForUser({ role: 'admin' });
    expect(result.size).toBeGreaterThan(0);
    expect(result.has('admin.access')).toBe(true);
  });

  it('returns a non-empty set for store user', () => {
    const result = permissionsForUser({ role: 'store' });
    expect(result.size).toBeGreaterThan(0);
    expect(result.has('merchant.access')).toBe(true);
  });

  it('returns a non-empty set for user role', () => {
    const result = permissionsForUser({ role: 'user' });
    expect(result.size).toBeGreaterThan(0);
    expect(result.has('user.profile.read')).toBe(true);
  });

  it('returns the user-tier set for null / undefined', () => {
    const fromNull = permissionsForUser(null);
    const fromUndefined = permissionsForUser(undefined);
    expect(fromNull.size).toBeGreaterThan(0);
    expect(fromNull).toEqual(fromUndefined);
    expect(fromNull.has('user.profile.read')).toBe(true);
    expect(fromNull.has('admin.access')).toBe(false);
  });

  it('returns a fresh Set on each call (callers may mutate)', () => {
    const a = permissionsForUser({ role: 'admin' });
    const b = permissionsForUser({ role: 'admin' });
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('admin and store sets are disjoint on the core capability gates', () => {
    const admin = permissionsForUser({ role: 'admin' });
    const store = permissionsForUser({ role: 'store' });
    expect(admin.has('admin.access')).toBe(true);
    expect(store.has('admin.access')).toBe(false);
    expect(admin.has('merchant.access')).toBe(false);
    expect(store.has('merchant.access')).toBe(true);
  });
});
