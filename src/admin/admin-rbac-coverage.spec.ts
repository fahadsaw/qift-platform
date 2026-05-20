// Authorization-flow coverage for AdminController — PR B-5.
//
// PURPOSE
// Two contracts to pin during the staged RBAC rollout (AdminGuard
// migrated in B-4; OpsRoleGuard migration deferred to B-6a):
//
//   1. Endpoint metadata. Every /admin/* GET route carries the
//      expected combination of controller-level guards +
//      (optional) @RequireOpsPermission metadata. A future refactor
//      that drops a guard, changes a decorator, renames a route, or
//      forgets to gate a new finance/diagnostic surface fails at
//      this assertion layer — well before any user is denied at
//      runtime.
//
//   2. Guard-chain composition. The migrated AdminGuard (B-4) and
//      not-yet-migrated OpsRoleGuard (B-6a) compose identically
//      under both kill-switch states. The new hasPermission(...)
//      path must not perturb req in a way that disturbs
//      OpsRoleGuard's metadata-driven gating.
//
// NON-GOAL
// This is NOT an e2e test. The standalone correctness of each guard
// is exhaustively covered in admin.guard.spec.ts and
// ops-role.guard.spec.ts. This file verifies the SEAM — the
// composition of the two guards across every endpoint surface, and
// the static metadata of every documented route.

import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OpsRoleGuard } from '../ops-roles/ops-role.guard';
import type { PrismaService } from '../prisma/prisma.service';
import type { OpsRolesService } from '../ops-roles/ops-roles.service';
import type { OpsPermission } from '../ops-roles/ops-roles';

// Nest internal metadata keys. Stable across Nest 10/11; pinned as
// literals here so this spec does not depend on the unstable
// `@nestjs/common/constants` subpath.
const GUARDS_METADATA = '__guards__';
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const OPS_PERM_META_KEY = 'qift:opsPermission';

// Documented /admin/* GET-endpoint surface. Kept as an explicit data
// table so adding or removing an endpoint forces a deliberate update
// here — and a coordinating thought about whether the new route
// needs an ops-permission gate.
type AdminGetRoute = {
  method: keyof AdminController;
  path: string;
  opsPermission: OpsPermission | null;
};

const ADMIN_GET_ROUTES: readonly AdminGetRoute[] = [
  { method: 'listUsers', path: 'users', opsPermission: null },
  { method: 'listStores', path: 'stores', opsPermission: null },
  { method: 'storeDetail', path: 'stores/:id/detail', opsPermission: null },
  {
    method: 'listUserOpsRoles',
    path: 'users/:id/ops-roles',
    opsPermission: 'user.read',
  },
  {
    method: 'storeDocuments',
    path: 'stores/:id/documents',
    opsPermission: null,
  },
  { method: 'listGifts', path: 'gifts', opsPermission: null },
  { method: 'listReports', path: 'reports', opsPermission: null },
  { method: 'systemStatus', path: 'system', opsPermission: null },
  { method: 'search', path: 'search', opsPermission: 'diagnostics.read' },
  {
    method: 'financeStoreBalances',
    path: 'finance/stores',
    opsPermission: 'finance.read_payouts',
  },
  {
    method: 'financeStoreEvents',
    path: 'finance/stores/:id/events',
    opsPermission: 'finance.read_payouts',
  },
  {
    method: 'diagnoseLatestGift',
    path: 'diagnose/gift/latest',
    opsPermission: null,
  },
  { method: 'diagnoseGift', path: 'diagnose/gift/:id', opsPermission: null },
  {
    method: 'debugLatestMerchantOrder',
    path: 'debug/latest-merchant-order',
    opsPermission: null,
  },
  { method: 'debugSeedStatus', path: 'debug/seed-status', opsPermission: null },
];

// Test helpers --------------------------------------------------------

function handlerFor(
  method: keyof AdminController,
): (...args: unknown[]) => unknown {
  const raw = (AdminController.prototype as unknown as Record<string, unknown>)[
    method
  ];
  if (typeof raw !== 'function') {
    throw new Error(
      `AdminController.${String(method)} is not a function on prototype`,
    );
  }
  return raw as (...args: unknown[]) => unknown;
}

function makeChainContext(opts: {
  userId?: string;
  handler: (...args: unknown[]) => unknown;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () =>
        opts.userId === undefined ? {} : { user: { userId: opts.userId } },
    }),
    getHandler: () => opts.handler,
    getClass: () => AdminController,
  } as unknown as ExecutionContext;
}

// --------------------------------------------------------------------

describe('AdminController authorization-flow coverage (B-5)', () => {
  const ORIGINAL_RBAC = process.env.RBAC_PERMISSION_CHECKS_ENABLED;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    // Mirror the env-restoration discipline of admin.guard.spec.ts
    // and ops-role.guard.spec.ts — sibling suites rely on
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
  describe('controller-level guards', () => {
    it('AdminController carries exactly [JwtAuthGuard, AdminGuard, OpsRoleGuard] in that order', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        AdminController,
      ) as unknown[];
      expect(guards).toEqual([JwtAuthGuard, AdminGuard, OpsRoleGuard]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('every /admin/* GET endpoint inventory', () => {
    it.each(ADMIN_GET_ROUTES)(
      'GET /admin/$path is wired to AdminController.$method',
      ({ method, path }) => {
        const handler = handlerFor(method);
        const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
          | number
          | undefined;
        const routePath = Reflect.getMetadata(PATH_METADATA, handler) as
          | string
          | undefined;
        expect(httpMethod).toBe(RequestMethod.GET);
        expect(routePath).toBe(path);
      },
    );

    it.each(ADMIN_GET_ROUTES.filter((r) => r.opsPermission === null))(
      'GET /admin/$path has NO @RequireOpsPermission decorator',
      ({ method }) => {
        const handler = handlerFor(method);
        const perm = Reflect.getMetadata(OPS_PERM_META_KEY, handler) as
          | OpsPermission
          | undefined;
        expect(perm).toBeUndefined();
      },
    );

    it.each(ADMIN_GET_ROUTES.filter((r) => r.opsPermission !== null))(
      'GET /admin/$path has @RequireOpsPermission($opsPermission)',
      ({ method, opsPermission }) => {
        const handler = handlerFor(method);
        const perm = Reflect.getMetadata(OPS_PERM_META_KEY, handler) as
          | OpsPermission
          | undefined;
        expect(perm).toBe(opsPermission);
      },
    );

    it('every documented route resolves to a real AdminController method', () => {
      // Guards against renaming a controller method without updating
      // this spec. The .each above tolerates missing handlers via
      // handlerFor's explicit throw, but this fails fast with the
      // full inventory.
      for (const route of ADMIN_GET_ROUTES) {
        expect(() => handlerFor(route.method)).not.toThrow();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('AdminGuard → OpsRoleGuard chain composition under both flag states', () => {
    let prismaFindUnique: jest.Mock;
    let userHasPermissionMock: jest.Mock;
    // PR B-6a: OpsRoleGuard's flag-ON path consults opsRoles.getUserRoles
    // and feeds the result through the catalog instead of calling
    // userHasPermission. The mock must exist (returning a Promise) for
    // tests that exercise the flag-ON path; default to [] so denial
    // cases work without explicit per-test setup.
    let getUserRolesMock: jest.Mock;
    let adminGuard: AdminGuard;
    let opsRoleGuard: OpsRoleGuard;

    beforeEach(() => {
      prismaFindUnique = jest.fn();
      userHasPermissionMock = jest.fn();
      getUserRolesMock = jest.fn().mockResolvedValue([]);
      adminGuard = new AdminGuard({
        user: { findUnique: prismaFindUnique },
      } as unknown as PrismaService);
      opsRoleGuard = new OpsRoleGuard(new Reflector(), {
        userHasPermission: userHasPermissionMock,
        getUserRoles: getUserRolesMock,
      } as unknown as OpsRolesService);
    });

    async function runChain(opts: {
      userId: string | undefined;
      handler: (...args: unknown[]) => unknown;
    }): Promise<true> {
      const ctx = makeChainContext(opts);
      await adminGuard.canActivate(ctx);
      await opsRoleGuard.canActivate(ctx);
      return true;
    }

    type FlagCase = [label: string, flag: '0' | '1'];
    const FLAG_CASES: FlagCase[] = [
      ['flag OFF', '0'],
      ['flag ON', '1'],
    ];

    const undecoratedHandler = handlerFor('listUsers');
    const decoratedHandler = handlerFor('financeStoreBalances');

    it.each(FLAG_CASES)(
      '%s: admin + undecorated route → chain passes; OpsRoleGuard no-ops',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
        await expect(
          runChain({ userId: 'admin-1', handler: undecoratedHandler }),
        ).resolves.toBe(true);
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );

    it.each(FLAG_CASES)(
      '%s: admin WITH ops permission + decorated route → chain passes',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
        // Provision BOTH dispatch sources so the test outcome is the
        // same under either flag state:
        //   - flag OFF → legacy userHasPermission returns true
        //   - flag ON  → getUserRoles yields 'finance', which grants
        //                finance.read_payouts in the catalog
        // The internal-call assertion (which method was actually
        // invoked) is covered by ops-role.guard.spec.ts. Here we
        // only assert the COMPOSED outcome of AdminGuard +
        // OpsRoleGuard.
        userHasPermissionMock.mockResolvedValue(true);
        getUserRolesMock.mockResolvedValue(['finance']);
        await expect(
          runChain({ userId: 'admin-1', handler: decoratedHandler }),
        ).resolves.toBe(true);
      },
    );

    it.each(FLAG_CASES)(
      '%s: admin WITHOUT ops permission + decorated route → OpsRoleGuard rejects with stable message',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
        userHasPermissionMock.mockResolvedValue(false);
        await expect(
          runChain({ userId: 'admin-1', handler: decoratedHandler }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          runChain({ userId: 'admin-1', handler: decoratedHandler }),
        ).rejects.toThrow('Operation requires elevated permissions');
      },
    );

    it.each(FLAG_CASES)(
      '%s: non-admin + decorated route → AdminGuard rejects BEFORE OpsRoleGuard runs',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        prismaFindUnique.mockResolvedValue({ role: 'store', deletedAt: null });
        await expect(
          runChain({ userId: 'store-1', handler: decoratedHandler }),
        ).rejects.toThrow('Admin access required');
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );

    it.each(FLAG_CASES)(
      '%s: non-admin + undecorated route → AdminGuard rejects with stable message',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        prismaFindUnique.mockResolvedValue({ role: 'user', deletedAt: null });
        await expect(
          runChain({ userId: 'user-1', handler: undecoratedHandler }),
        ).rejects.toThrow('Admin access required');
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );

    it.each(FLAG_CASES)(
      '%s: soft-deleted admin → rejected regardless of catalog or decorator',
      async (_label, flag) => {
        // Identity invariant: a deletedAt account must never authorise
        // even when the migrated path says legacy_admin holds
        // admin.access. The rejection short-circuits the chain before
        // either the RBAC dispatch or OpsRoleGuard sees the request.
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        prismaFindUnique.mockResolvedValue({
          role: 'admin',
          deletedAt: new Date('2025-01-01T00:00:00Z'),
        });
        await expect(
          runChain({ userId: 'admin-1', handler: decoratedHandler }),
        ).rejects.toThrow('Admin access required');
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );

    it.each(FLAG_CASES)(
      '%s: missing req.user → AdminGuard rejects without DB lookup',
      async (_label, flag) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
        await expect(
          runChain({ userId: undefined, handler: decoratedHandler }),
        ).rejects.toThrow('Admin access required');
        expect(prismaFindUnique).not.toHaveBeenCalled();
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────
  describe('exhaustive: every undecorated GET endpoint passes under both flag states', () => {
    // Per-route smoke of the AdminGuard-only path. Confirms that no
    // endpoint accidentally inherits a stray @RequireOpsPermission
    // from a copy/paste, and that the migrated AdminGuard's new path
    // authorises legacy_admin on every undecorated endpoint.

    let prismaFindUnique: jest.Mock;
    let userHasPermissionMock: jest.Mock;
    // PR B-6a: same reason as the block above — the flag-ON path
    // would call getUserRoles. Undecorated routes don't actually
    // reach the dispatch branch (OpsRoleGuard short-circuits on
    // missing metadata) so the default [] suffices.
    let getUserRolesMock: jest.Mock;
    let adminGuard: AdminGuard;
    let opsRoleGuard: OpsRoleGuard;

    beforeEach(() => {
      prismaFindUnique = jest.fn().mockResolvedValue({
        role: 'admin',
        deletedAt: null,
      });
      userHasPermissionMock = jest.fn();
      getUserRolesMock = jest.fn().mockResolvedValue([]);
      adminGuard = new AdminGuard({
        user: { findUnique: prismaFindUnique },
      } as unknown as PrismaService);
      opsRoleGuard = new OpsRoleGuard(new Reflector(), {
        userHasPermission: userHasPermissionMock,
        getUserRoles: getUserRolesMock,
      } as unknown as OpsRolesService);
    });

    const undecoratedRoutes = ADMIN_GET_ROUTES.filter(
      (r) => r.opsPermission === null,
    );

    it.each(undecoratedRoutes)(
      'flag OFF: GET /admin/$path → admin authorises through both guards',
      async ({ method }) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
        const ctx = makeChainContext({
          userId: 'admin-1',
          handler: handlerFor(method),
        });
        await expect(adminGuard.canActivate(ctx)).resolves.toBe(true);
        await expect(opsRoleGuard.canActivate(ctx)).resolves.toBe(true);
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );

    it.each(undecoratedRoutes)(
      'flag ON: GET /admin/$path → admin authorises through both guards',
      async ({ method }) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
        const ctx = makeChainContext({
          userId: 'admin-1',
          handler: handlerFor(method),
        });
        await expect(adminGuard.canActivate(ctx)).resolves.toBe(true);
        await expect(opsRoleGuard.canActivate(ctx)).resolves.toBe(true);
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────
  describe('exhaustive: every decorated GET endpoint enforces its ops-permission under both flag states', () => {
    // Per-route smoke of the AdminGuard → OpsRoleGuard chain. Confirms
    // that each decorated route's metadata flows through to the
    // dispatch path:
    //   - flag OFF: userHasPermission(userId, opsPermission) is
    //     called with the documented permission identifier.
    //   - flag ON  (PR B-6a): getUserRoles(userId) is called, and
    //     the catalog correctly authorises a super_admin grant.
    // Per-(role, permission) equivalence between the two paths is
    // proved by ops-roles-catalog-equivalence.spec.ts — this block
    // proves the documented permission is correctly threaded into
    // the dispatch on every route.

    let prismaFindUnique: jest.Mock;
    let userHasPermissionMock: jest.Mock;
    let getUserRolesMock: jest.Mock;
    let adminGuard: AdminGuard;
    let opsRoleGuard: OpsRoleGuard;

    beforeEach(() => {
      prismaFindUnique = jest.fn().mockResolvedValue({
        role: 'admin',
        deletedAt: null,
      });
      userHasPermissionMock = jest.fn().mockResolvedValue(true);
      // super_admin holds every OpsPermission via the catalog's
      // ALL_ADMIN_PERMISSIONS aggregate — exhaustively asserted by
      // ops-roles-catalog-equivalence.spec.ts. Using it here means
      // every parameterised decorated-route case authorises under
      // the flag-ON path regardless of which OpsPermission the
      // route requires.
      getUserRolesMock = jest.fn().mockResolvedValue(['super_admin']);
      adminGuard = new AdminGuard({
        user: { findUnique: prismaFindUnique },
      } as unknown as PrismaService);
      opsRoleGuard = new OpsRoleGuard(new Reflector(), {
        userHasPermission: userHasPermissionMock,
        getUserRoles: getUserRolesMock,
      } as unknown as OpsRolesService);
    });

    const decoratedRoutes = ADMIN_GET_ROUTES.filter(
      (r) => r.opsPermission !== null,
    );

    it.each(decoratedRoutes)(
      'flag OFF: GET /admin/$path calls opsRoles.userHasPermission(_, $opsPermission)',
      async ({ method, opsPermission }) => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
        const ctx = makeChainContext({
          userId: 'admin-1',
          handler: handlerFor(method),
        });
        await adminGuard.canActivate(ctx);
        await opsRoleGuard.canActivate(ctx);
        expect(userHasPermissionMock).toHaveBeenCalledWith(
          'admin-1',
          opsPermission,
        );
        expect(getUserRolesMock).not.toHaveBeenCalled();
      },
    );

    it.each(decoratedRoutes)(
      'flag ON: GET /admin/$path consults catalog via opsRoles.getUserRoles',
      async ({ method }) => {
        // The documented OpsPermission is no longer threaded through
        // a service call argument under flag ON — it is consumed
        // internally by permissionsForRoles(roles).has(perm). Asserting
        // the per-permission threading under flag ON would require
        // mocking the catalog itself, which buys nothing the
        // ops-roles-catalog-equivalence.spec.ts proof doesn't already
        // give us. So under flag ON we assert the dispatch direction
        // + the composed outcome.
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
        const ctx = makeChainContext({
          userId: 'admin-1',
          handler: handlerFor(method),
        });
        await adminGuard.canActivate(ctx);
        await expect(opsRoleGuard.canActivate(ctx)).resolves.toBe(true);
        expect(getUserRolesMock).toHaveBeenCalledWith('admin-1');
        expect(userHasPermissionMock).not.toHaveBeenCalled();
      },
    );
  });
});
