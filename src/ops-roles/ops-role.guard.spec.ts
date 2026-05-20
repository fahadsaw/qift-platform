// Unit tests for OpsRoleGuard — PR B-5 (verification + kill-switch
// independence pin).
//
// OpsRoleGuard's migration to the unified RBAC catalog is deferred
// to PR B-6a per src/rbac/MIGRATION_PLAN.md. This spec exists to
// pin three contracts during the B-4 → B-6a window:
//
//   1. OpsRoleGuard's behaviour is identical under both kill-switch
//      states. Migrated AdminGuard runs first; OpsRoleGuard inherits
//      whatever it leaves on req. The new AdminGuard path must not
//      perturb OpsRoleGuard's authorisation outcome.
//
//   2. OpsRoleGuard does NOT yet read the kill-switch flag. Any
//      accidental coupling (a stray import, a flag read) would
//      conflate the AdminGuard migration with the OpsRoleGuard
//      migration and break the staged rollout discipline.
//
//   3. The OpsRoleGuard behavioural contract — metadata-driven no-op
//      vs gated access vs 'Operation requires elevated permissions'
//      — is unchanged. Future PR B-6a will rewrite OpsRoleGuard
//      internals; this spec is the regression-safety net against
//      accidental scope creep before then.

import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OpsRoleGuard } from './ops-role.guard';
import type { OpsPermission } from './ops-roles';
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
  let guard: OpsRoleGuard;
  const ORIGINAL_RBAC = process.env.RBAC_PERMISSION_CHECKS_ENABLED;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    userHasPermissionMock = jest.fn();
    const fakeOpsRoles = { userHasPermission: userHasPermissionMock };
    guard = new OpsRoleGuard(
      new Reflector(),
      fakeOpsRoles as unknown as OpsRolesService,
    );
  });

  afterEach(() => {
    // Hermetic env restoration — same discipline as
    // admin.guard.spec.ts. Sibling test suites rely on
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
    it('returns true without consulting ops-roles', async () => {
      const ctx = makeContext({ user: { userId: 'u-1' } });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(userHasPermissionMock).not.toHaveBeenCalled();
    });

    it('returns true even when req.user is absent', async () => {
      // A route without @RequireOpsPermission must never trip a 403
      // on a valid admin request — even if an upstream guard somehow
      // forgot to populate req.user. The short-circuit on absent
      // metadata MUST run before any user-context inspection.
      const ctx = makeContext({ user: undefined });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(userHasPermissionMock).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('metadata present', () => {
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

    it('honours class-level metadata when handler has none (Reflector getAllAndOverride)', async () => {
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
  describe('behaviour is identical under both kill-switch states', () => {
    // OpsRoleGuard does not read the flag (its migration is B-6a).
    // These assertions PIN that contract: flipping
    // RBAC_PERMISSION_CHECKS_ENABLED must not change a single
    // OpsRoleGuard outcome.

    type FlagCase = [label: string, flag: '0' | '1'];
    const FLAG_CASES: FlagCase[] = [
      ['flag OFF', '0'],
      ['flag ON', '1'],
    ];

    it.each(FLAG_CASES)(
      '%s: no metadata → returns true',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        const ctx = makeContext({ user: { userId: 'u-1' } });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      },
    );

    it.each(FLAG_CASES)(
      '%s: metadata + ops-permission granted → returns true',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        userHasPermissionMock.mockResolvedValue(true);
        const ctx = makeContext({
          permissionOnHandler: 'user.read',
          user: { userId: 'u-1' },
        });
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      },
    );

    it.each(FLAG_CASES)(
      '%s: metadata + ops-permission denied → throws identical message',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        userHasPermissionMock.mockResolvedValue(false);
        const ctx = makeContext({
          permissionOnHandler: 'finance.read_payouts',
          user: { userId: 'u-1' },
        });
        await expect(guard.canActivate(ctx)).rejects.toThrow(
          'Operation requires elevated permissions',
        );
      },
    );

    it.each(FLAG_CASES)(
      '%s: metadata + missing userId → throws "Missing user context"',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        const ctx = makeContext({
          permissionOnHandler: 'user.read',
          user: undefined,
        });
        await expect(guard.canActivate(ctx)).rejects.toThrow(
          'Missing user context',
        );
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────
  describe('kill-switch independence (PR B-6a deferral pin)', () => {
    // The guard's source must not reference the kill-switch flag.
    // Any accidental coupling — direct import of
    // arePermissionChecksEnabled / hasPermission, a literal
    // RBAC_PERMISSION_CHECKS_ENABLED env read, an import from
    // ../rbac — would conflate the AdminGuard migration with the
    // OpsRoleGuard migration. PR B-6a will replace these
    // assertions with structural ones once the migration lands.
    const guardSource = readFileSync(
      require.resolve('./ops-role.guard'),
      'utf8',
    );

    it('does NOT reference arePermissionChecksEnabled', () => {
      expect(guardSource).not.toContain('arePermissionChecksEnabled');
    });

    it('does NOT reference hasPermission', () => {
      expect(guardSource).not.toContain('hasPermission');
    });

    it('does NOT reference RBAC_PERMISSION_CHECKS_ENABLED', () => {
      expect(guardSource).not.toContain('RBAC_PERMISSION_CHECKS_ENABLED');
    });

    it('does NOT import from ../rbac', () => {
      expect(guardSource).not.toMatch(/from\s+['"]\.\.\/rbac['"]/);
    });
  });
});
