// Unit tests for OpsRoleGuard.
//
// HISTORY
// PR B-5 created this spec while OpsRoleGuard was still on the
// legacy ops-roles.ts path. It pinned the deferral discipline with
// source-level assertions ("kill-switch independence") so any
// accidental coupling to RBAC_PERMISSION_CHECKS_ENABLED would fail
// loud before B-6a was ready.
//
// PR B-6a (this PR) replaces the deferral-pin block with structural
// assertions on the new dual-path dispatch. The guard now reads the
// kill-switch on every request and routes either to
// opsRoles.userHasPermission (legacy) or to permissionsForRoles via
// opsRoles.getUserRoles (catalog). Behaviour preservation across the
// flag flip is established by ops-roles-catalog-equivalence.spec.ts.
//
// COVERAGE
//   1. No metadata → guard short-circuits without consulting either
//      service method (unchanged from B-5).
//   2. Flag OFF (legacy path): user-has-permission true/false,
//      missing-userId, class-vs-handler metadata precedence — all
//      route through opsRoles.userHasPermission(userId, perm).
//   3. Flag ON  (catalog path): same matrix, routes through
//      opsRoles.getUserRoles(userId) + permissionsForRoles(roles).
//   4. Exception messages identical across both flag states.
//   5. Dispatch direction (the new pin replacing B-5's
//      deferral-pin): under flag OFF only userHasPermission is
//      invoked; under flag ON only getUserRoles is invoked.

import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OpsRoleGuard } from './ops-role.guard';
import type { OpsPermission, OpsRole } from './ops-roles';
import type { OpsRolesService } from './ops-roles.service';

const META_KEY = 'qift:opsPermission';

// Test helpers ---------------------------------------------------------

function makeContext(opts: {
  permissionOnHandler?: OpsPermission;
  permissionOnClass?: OpsPermission;
  user?: { userId: string };
}): ExecutionContext {
  // A bare function + class with reflect-metadata attached mirror
  // what @RequireOpsPermission produces in production: a getHandler()
  // and getClass() the Reflector can read metadata from. The guard
  // never looks INSIDE the handler — it only reads its metadata.
  const handler = function dummyHandler(): void {
    // intentionally empty
  };
  if (opts.permissionOnHandler !== undefined) {
    Reflect.defineMetadata(META_KEY, opts.permissionOnHandler, handler);
  }
  const klass = class DummyController {};
  if (opts.permissionOnClass !== undefined) {
    Reflect.defineMetadata(META_KEY, opts.permissionOnClass, klass);
  }
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: opts.user }),
    }),
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------

describe('OpsRoleGuard', () => {
  let userHasPermissionMock: jest.Mock;
  let getUserRolesMock: jest.Mock;
  let guard: OpsRoleGuard;
  const ORIGINAL_RBAC = process.env.RBAC_PERMISSION_CHECKS_ENABLED;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    userHasPermissionMock = jest.fn();
    // Default getUserRoles to empty so flag-ON tests that don't care
    // about role grants still resolve a Promise instead of throwing
    // TypeError on `await undefined`. Tests that need a specific
    // grant override this in-test.
    getUserRolesMock = jest.fn().mockResolvedValue([]);
    const fakeOpsRoles = {
      userHasPermission: userHasPermissionMock,
      getUserRoles: getUserRolesMock,
    };
    guard = new OpsRoleGuard(
      new Reflector(),
      fakeOpsRoles as unknown as OpsRolesService,
    );
  });

  afterEach(() => {
    // Hermetic env restoration — same discipline as
    // admin.guard.spec.ts. Sibling suites rely on
    // NODE_ENV === 'test'.
    if (ORIGINAL_RBAC === undefined) {
      delete process.env.RBAC_PERMISSION_CHECKS_ENABLED;
    } else {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = ORIGINAL_RBAC;
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  // ─────────────────────────────────────────────────────────────────
  describe('no metadata (route without @RequireOpsPermission)', () => {
    // Short-circuit runs BEFORE either dispatch branch — neither
    // service method is consulted, regardless of flag state.
    it('returns true without consulting ops-roles (flag OFF)', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      const ctx = makeContext({ user: { userId: 'u-1' } });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(userHasPermissionMock).not.toHaveBeenCalled();
      expect(getUserRolesMock).not.toHaveBeenCalled();
    });

    it('returns true without consulting ops-roles (flag ON)', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      const ctx = makeContext({ user: { userId: 'u-1' } });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(userHasPermissionMock).not.toHaveBeenCalled();
      expect(getUserRolesMock).not.toHaveBeenCalled();
    });

    it('returns true even when req.user is absent (flag OFF)', async () => {
      // A route without @RequireOpsPermission must never trip a 403
      // on a valid admin request — even if an upstream guard somehow
      // forgot to populate req.user. The short-circuit on absent
      // metadata MUST run before any user-context inspection.
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      const ctx = makeContext({ user: undefined });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('returns true even when req.user is absent (flag ON)', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      const ctx = makeContext({ user: undefined });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('metadata present — flag OFF (legacy ops-roles.ts path)', () => {
    beforeEach(() => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
    });

    it('returns true when opsRoles.userHasPermission returns true', async () => {
      userHasPermissionMock.mockResolvedValue(true);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: { userId: 'u-1' },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(userHasPermissionMock).toHaveBeenCalledWith('u-1', 'user.read');
    });

    it('throws "Operation requires elevated permissions" when userHasPermission returns false', async () => {
      userHasPermissionMock.mockResolvedValue(false);
      const ctx = makeContext({
        permissionOnHandler: 'finance.read_payouts',
        user: { userId: 'u-1' },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Operation requires elevated permissions',
      );
    });

    it('throws "Missing user context" when req.user is absent', async () => {
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: undefined,
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing user context',
      );
    });

    it('honours class-level metadata when handler has none', async () => {
      userHasPermissionMock.mockResolvedValue(true);
      const ctx = makeContext({
        permissionOnClass: 'diagnostics.read',
        user: { userId: 'u-1' },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(userHasPermissionMock).toHaveBeenCalledWith(
        'u-1',
        'diagnostics.read',
      );
    });

    it('handler-level metadata overrides class-level metadata', async () => {
      userHasPermissionMock.mockResolvedValue(true);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        permissionOnClass: 'diagnostics.read',
        user: { userId: 'u-1' },
      });
      await guard.canActivate(ctx);
      expect(userHasPermissionMock).toHaveBeenCalledWith('u-1', 'user.read');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('metadata present — flag ON (unified RBAC catalog path)', () => {
    beforeEach(() => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
    });

    it('returns true when getUserRoles yields a role granting the permission', async () => {
      // operations_manager grants user.read in both maps (verified
      // exhaustively by ops-roles-catalog-equivalence.spec.ts).
      const grantingRoles: OpsRole[] = ['operations_manager'];
      getUserRolesMock.mockResolvedValue(grantingRoles);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: { userId: 'u-1' },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(getUserRolesMock).toHaveBeenCalledWith('u-1');
    });

    it('throws "Operation requires elevated permissions" when getUserRoles yields no granting role', async () => {
      // analytics_viewer holds only analytics.read; checking
      // finance.read_payouts must reject.
      const nonGrantingRoles: OpsRole[] = ['analytics_viewer'];
      getUserRolesMock.mockResolvedValue(nonGrantingRoles);
      const ctx = makeContext({
        permissionOnHandler: 'finance.read_payouts',
        user: { userId: 'u-1' },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Operation requires elevated permissions',
      );
    });

    it('throws "Operation requires elevated permissions" when getUserRoles yields an empty list', async () => {
      // No ops-role assignments at all — admin without granular grants.
      getUserRolesMock.mockResolvedValue([]);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: { userId: 'u-1' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Operation requires elevated permissions',
      );
    });

    it('throws "Missing user context" when req.user is absent', async () => {
      // Same upstream short-circuit as flag OFF. No DB read.
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: undefined,
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing user context',
      );
      expect(getUserRolesMock).not.toHaveBeenCalled();
    });

    it('honours class-level metadata when handler has none', async () => {
      getUserRolesMock.mockResolvedValue(['support']);
      const ctx = makeContext({
        permissionOnClass: 'diagnostics.read',
        user: { userId: 'u-1' },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(getUserRolesMock).toHaveBeenCalledWith('u-1');
    });

    it('handler-level metadata overrides class-level metadata', async () => {
      // Handler asks for user.read; class asks for diagnostics.read.
      // Role 'trust_safety' grants user.read but NOT diagnostics.read.
      // If the handler metadata wins, this passes; if the class wins,
      // this rejects.
      getUserRolesMock.mockResolvedValue(['trust_safety']);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        permissionOnClass: 'diagnostics.read',
        user: { userId: 'u-1' },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('OR-semantics across multiple roles: any role granting the permission authorises', async () => {
      // User holds two roles; only one grants the permission. The
      // catalog's permissionsForRoles unions the grants — guard must
      // authorise.
      getUserRolesMock.mockResolvedValue(['analytics_viewer', 'finance']);
      const ctx = makeContext({
        permissionOnHandler: 'finance.read_payouts',
        user: { userId: 'u-1' },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('exception messages identical across both flag states', () => {
    // The exact strings the frontend / clients depend on for routing
    // and copy. Any drift would surface as user-facing UI regression.

    it('flag OFF: denial → "Operation requires elevated permissions"', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      userHasPermissionMock.mockResolvedValue(false);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: { userId: 'u-1' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Operation requires elevated permissions',
      );
    });

    it('flag ON: denial → "Operation requires elevated permissions"', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      getUserRolesMock.mockResolvedValue([]);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: { userId: 'u-1' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Operation requires elevated permissions',
      );
    });

    it('flag OFF: missing userId → "Missing user context"', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: undefined,
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing user context',
      );
    });

    it('flag ON: missing userId → "Missing user context"', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: undefined,
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing user context',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('dispatch direction (PR B-6a migration assertion)', () => {
    // Replaces B-5's "kill-switch independence (PR B-6a deferral pin)"
    // block. With B-6a merged, the deferral is over — the guard now
    // DOES read the kill-switch and dispatches accordingly. These
    // assertions pin the direction of dispatch so any future
    // accidental swap (flag OFF accidentally calls catalog; flag ON
    // accidentally calls legacy) fails fast.

    it('flag OFF → opsRoles.userHasPermission is called; getUserRoles is NOT', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      userHasPermissionMock.mockResolvedValue(true);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: { userId: 'u-1' },
      });
      await guard.canActivate(ctx);
      expect(userHasPermissionMock).toHaveBeenCalledTimes(1);
      expect(userHasPermissionMock).toHaveBeenCalledWith('u-1', 'user.read');
      expect(getUserRolesMock).not.toHaveBeenCalled();
    });

    it('flag ON → opsRoles.getUserRoles is called; userHasPermission is NOT', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      getUserRolesMock.mockResolvedValue(['operations_manager']);
      const ctx = makeContext({
        permissionOnHandler: 'user.read',
        user: { userId: 'u-1' },
      });
      await guard.canActivate(ctx);
      expect(getUserRolesMock).toHaveBeenCalledTimes(1);
      expect(getUserRolesMock).toHaveBeenCalledWith('u-1');
      expect(userHasPermissionMock).not.toHaveBeenCalled();
    });
  });
});
