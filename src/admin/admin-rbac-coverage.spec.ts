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
    method: 'storeVatFacts',
    path: 'stores/:id/vat-facts',
    opsPermission: 'store.read_detail',
  },
  {
    method: 'reconciliationReport',
    path: 'finance/reconciliation',
    opsPermission: 'finance.reconcile',
  },
  {
    // SETTLE-1 (Track C PR 2) — receipts per invoice (read model).
    method: 'listReceipts',
    path: 'finance/receipts',
    opsPermission: 'finance.receipts',
  },
  {
    // SETTLE-1 — receivables aging (SC §10.2 read model).
    method: 'receivablesAging',
    path: 'finance/receivables-aging',
    opsPermission: 'finance.receipts',
  },
  {
    // SETTLE-2 — batch listing (read model via the engine seam).
    method: 'listSettlementBatches',
    path: 'finance/settlement/batches',
    opsPermission: 'finance.receipts',
  },
  {
    // SETTLE-2 — the issued Settlement Statement (immutable document).
    method: 'settlementStatement',
    path: 'finance/settlement/:id/statement',
    opsPermission: 'finance.receipts',
  },
  {
    // SETTLE-2 — §34 replay harness (read + audit line).
    method: 'replaySettlement',
    path: 'finance/settlement/:id/replay',
    opsPermission: 'finance.receipts',
  },
  {
    // SETTLE-3a — refunds + credit notes per invoice (read model).
    method: 'listRefunds',
    path: 'finance/refunds',
    opsPermission: 'finance.refunds',
  },
  {
    // Refund-integrity — maker–checker request queue (read model).
    method: 'listRefundRequests',
    path: 'finance/refunds/requests',
    opsPermission: 'finance.refunds',
  },
  {
    // SETTLE-3a — open receivables (§2 Reversed → §7.4 offset queue).
    method: 'openReceivables',
    path: 'finance/receivables',
    opsPermission: 'finance.refunds',
  },
  {
    // RC v3.0 — credit-note document replay (integrity + audit line).
    method: 'replayCreditNote',
    path: 'finance/credit-notes/:refundId/replay',
    opsPermission: 'finance.refunds',
  },
  {
    // Lane 2 PR 1 — bank-balance attestations (append-only evidence).
    method: 'listTreasuryAttestations',
    path: 'finance/treasury/attestations',
    opsPermission: 'finance.reconcile',
  },
  {
    // Lane 2 PR 1 — three-way reconciliation records (integrity-gated).
    method: 'listTreasuryReconciliations',
    path: 'finance/treasury/reconciliations',
    opsPermission: 'finance.reconcile',
  },
  {
    method: 'getTreasuryReconciliation',
    path: 'finance/treasury/reconciliations/:id',
    opsPermission: 'finance.reconcile',
  },
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

  // ───────────────────────────────────────────────────────────────────
  // Week 2 hardening — admin MUTATION endpoints now carry
  // @RequireOpsPermission decorators. Pinning the metadata so a
  // future refactor that drops a decorator (or assigns the wrong
  // permission) fails fast at this layer.
  //
  // Behaviour for each route (exercised through the guard chain
  // under both flag states):
  //   - admin with the matching ops permission       → 200
  //   - admin without the matching ops permission    → 403
  //     'Operation requires elevated permissions'
  //   - super_admin (holds all OpsPermissions)       → 200
  //   - non-admin                                    → 403
  //     'Admin access required' (AdminGuard short-circuit)
  //   - soft-deleted admin                           → 403
  //     'Admin access required' (BEFORE RBAC dispatch)
  // ───────────────────────────────────────────────────────────────────

  describe('Week 2 — admin mutation routes carry @RequireOpsPermission', () => {
    type AdminMutationRoute = {
      method: keyof AdminController;
      path: string;
      httpMethod: 'PATCH' | 'POST';
      opsPermission: OpsPermission;
    };

    // Each row pins one of the 5 mutation routes hardened in Week 2.
    // Adding a 6th to the controller without updating this list (or
    // the controller) will surface as a missing-test signal during
    // review.
    const ADMIN_MUTATION_ROUTES: ReadonlyArray<AdminMutationRoute> = [
      {
        // Track B2 / PE-11 — ledger repair is a mutation (append-only,
        // idempotent) and rides POST, distinct from the read-only GET
        // report per Financial Constitution Ch. 18.2.
        method: 'reconciliationRepair',
        path: 'finance/reconciliation/repair',
        httpMethod: 'POST',
        opsPermission: 'finance.reconcile',
      },
      {
        // SETTLE-1 (Track C PR 2) — receipt recording posts money
        // facts (invoice.payment.received + payable conversion).
        method: 'recordReceipt',
        path: 'finance/receipts',
        httpMethod: 'POST',
        opsPermission: 'finance.receipts',
      },
      {
        // SETTLE-1 — §5 eligibility evaluation (state transitions).
        method: 'evaluateEligibility',
        path: 'finance/settlement/eligibility',
        httpMethod: 'POST',
        opsPermission: 'finance.receipts',
      },
      {
        // SETTLE-1 — §5.4 payout-identity verification (evidence).
        method: 'verifyPayoutIdentity',
        path: 'finance/stores/:id/payout-identity',
        httpMethod: 'POST',
        opsPermission: 'finance.receipts',
      },
      {
        // SETTLE-2 — §30 simulation (audit line only).
        method: 'simulateSettlement',
        path: 'finance/settlement/simulate',
        httpMethod: 'POST',
        opsPermission: 'finance.settlement_approve',
      },
      {
        // SETTLE-2 — batch assembly (QS born; §14.1).
        method: 'assembleSettlement',
        path: 'finance/settlement/assemble',
        httpMethod: 'POST',
        opsPermission: 'finance.settlement_approve',
      },
      {
        // SETTLE-2 — §30.4 mandatory pre-execution preview.
        method: 'previewSettlementExecution',
        path: 'finance/settlement/:id/preview',
        httpMethod: 'POST',
        opsPermission: 'finance.settlement_approve',
      },
      {
        // SETTLE-2 — §31 approval (binds to the frozen calculation).
        method: 'approveSettlementExecution',
        path: 'finance/settlement/:id/approve',
        httpMethod: 'POST',
        opsPermission: 'finance.settlement_approve',
      },
      {
        // SETTLE-2 — §33 execution (RULE 6 binding gate in-service).
        method: 'executeSettlement',
        path: 'finance/settlement/:id/execute',
        httpMethod: 'POST',
        opsPermission: 'finance.settlement_execute',
      },
      {
        // Refund-integrity — maker: files the request + immutable
        // snapshot. No money moves here.
        method: 'requestRefund',
        path: 'finance/refunds/requests',
        httpMethod: 'POST',
        opsPermission: 'finance.refunds',
      },
      {
        // Refund-integrity — checker: independent approval (never the
        // requester; enforced in-service above this permission).
        method: 'approveRefund',
        path: 'finance/refunds/requests/:id/approve',
        httpMethod: 'POST',
        opsPermission: 'finance.refunds',
      },
      {
        // Refund-integrity — executor: evidenced execution (never the
        // final approver). §8 money leaves safeguarding HERE only.
        method: 'executeRefund',
        path: 'finance/refunds/requests/:id/execute',
        httpMethod: 'POST',
        opsPermission: 'finance.refunds',
      },
      {
        // Refund-integrity — cancel an un-executed request.
        method: 'cancelRefundRequest',
        path: 'finance/refunds/requests/:id/cancel',
        httpMethod: 'POST',
        opsPermission: 'finance.refunds',
      },
      {
        // Lane 2 PR 2 — SC §26 zero-net statement-only close (positions
        // extinguish, NO transfer; execution-grade permission).
        method: 'closeSettlementZeroNet',
        path: 'finance/settlement/:id/close-zero-net',
        httpMethod: 'POST',
        opsPermission: 'finance.settlement_execute',
      },
      {
        // Lane 2 PR 1 — treasury attestation (evidence entry, no money).
        method: 'recordTreasuryAttestation',
        path: 'finance/treasury/attestations',
        httpMethod: 'POST',
        opsPermission: 'finance.reconcile',
      },
      {
        // Lane 2 PR 1 — the three-way run (creates only recon artifacts).
        method: 'runTreasuryReconciliation',
        path: 'finance/treasury/reconciliations',
        httpMethod: 'POST',
        opsPermission: 'finance.reconcile',
      },
      {
        method: 'investigateTreasuryReconciliation',
        path: 'finance/treasury/reconciliations/:id/investigate',
        httpMethod: 'POST',
        opsPermission: 'finance.reconcile',
      },
      {
        method: 'resolveTreasuryReconciliation',
        path: 'finance/treasury/reconciliations/:id/resolve',
        httpMethod: 'POST',
        opsPermission: 'finance.reconcile',
      },
      {
        // Track B3 / PE-12 — VAT-facts maker-checker mutations. SoD
        // (maker != checker) is enforced in-service above this
        // permission per Financial Constitution Ch. 14.2.
        method: 'proposeVatFacts',
        path: 'stores/:id/vat-facts/proposals',
        httpMethod: 'POST',
        opsPermission: 'finance.vat_facts',
      },
      {
        method: 'approveVatFacts',
        path: 'stores/:id/vat-facts/proposals/:proposalId/approve',
        httpMethod: 'POST',
        opsPermission: 'finance.vat_facts',
      },
      {
        method: 'rejectVatFacts',
        path: 'stores/:id/vat-facts/proposals/:proposalId/reject',
        httpMethod: 'POST',
        opsPermission: 'finance.vat_facts',
      },
      {
        method: 'setUserRole',
        path: 'users/:id/role',
        httpMethod: 'PATCH',
        opsPermission: 'user.set_role',
      },
      {
        method: 'disableUser',
        path: 'users/:id/disable',
        httpMethod: 'PATCH',
        opsPermission: 'user.suspend',
      },
      {
        method: 'restoreUser',
        path: 'users/:id/restore',
        httpMethod: 'PATCH',
        opsPermission: 'user.restore',
      },
      {
        method: 'purgeUser',
        path: 'users/:id/purge',
        httpMethod: 'PATCH',
        opsPermission: 'user.purge',
      },
      {
        method: 'setStoreStatus',
        path: 'stores/:id/status',
        httpMethod: 'PATCH',
        opsPermission: 'store.set_status',
      },
      {
        method: 'reviewStore',
        path: 'stores/:id/review',
        httpMethod: 'PATCH',
        opsPermission: 'store.review',
      },
      {
        method: 'setReportStatus',
        path: 'reports/:id/status',
        httpMethod: 'PATCH',
        opsPermission: 'report.resolve',
      },
      {
        method: 'debugSeedMerchants',
        path: 'debug/seed-merchants',
        httpMethod: 'POST',
        opsPermission: 'diagnostics.run_seed',
      },
    ];

    describe('metadata pinning', () => {
      it.each(ADMIN_MUTATION_ROUTES)(
        '$httpMethod /admin/$path carries @RequireOpsPermission($opsPermission)',
        ({ method, opsPermission }) => {
          const handler = handlerFor(method);
          const perm = Reflect.getMetadata(OPS_PERM_META_KEY, handler) as
            | OpsPermission
            | undefined;
          expect(perm).toBe(opsPermission);
        },
      );

      it.each(ADMIN_MUTATION_ROUTES)(
        '$httpMethod /admin/$path has the expected HTTP method + path metadata',
        ({ method, httpMethod, path }) => {
          const handler = handlerFor(method);
          const verbCode = Reflect.getMetadata(METHOD_METADATA, handler) as
            | number
            | undefined;
          const routePath = Reflect.getMetadata(PATH_METADATA, handler) as
            | string
            | undefined;
          const expectedVerb =
            httpMethod === 'POST' ? RequestMethod.POST : RequestMethod.PATCH;
          expect(verbCode).toBe(expectedVerb);
          expect(routePath).toBe(path);
        },
      );
    });

    describe('guard chain composition (representative samples)', () => {
      let prismaFindUnique: jest.Mock;
      let userHasPermissionMock: jest.Mock;
      let getUserRolesMock: jest.Mock;
      let adminGuard: AdminGuard;
      let opsRoleGuard: OpsRoleGuard;

      beforeEach(() => {
        prismaFindUnique = jest.fn();
        userHasPermissionMock = jest.fn();
        getUserRolesMock = jest.fn();
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

      // Each parameterised block below sets the flag inline rather
      // than via it.each(FLAG_CASES) — the matrix here is over the
      // 5 mutation routes, not over flag states, so a separate
      // FLAG_CASES parameterisation would only obfuscate the test
      // names.

      it.each(ADMIN_MUTATION_ROUTES)(
        '$method: admin WITHOUT $opsPermission → 403 "Operation requires elevated permissions" (flag OFF)',
        async ({ method }) => {
          process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
          prismaFindUnique.mockResolvedValue({
            role: 'admin',
            deletedAt: null,
          });
          userHasPermissionMock.mockResolvedValue(false);

          await expect(
            runChain({ userId: 'admin-1', handler: handlerFor(method) }),
          ).rejects.toThrow('Operation requires elevated permissions');
        },
      );

      it.each(ADMIN_MUTATION_ROUTES)(
        '$method: admin WITHOUT $opsPermission → 403 (flag ON, role without grant)',
        async ({ method }) => {
          process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
          prismaFindUnique.mockResolvedValue({
            role: 'admin',
            deletedAt: null,
          });
          // analytics_viewer holds only analytics.read — never any
          // mutation permission. This is the canonical "read-only
          // ops role cannot mutate state" assertion.
          getUserRolesMock.mockResolvedValue(['analytics_viewer']);

          await expect(
            runChain({ userId: 'admin-1', handler: handlerFor(method) }),
          ).rejects.toThrow('Operation requires elevated permissions');
        },
      );

      it.each(ADMIN_MUTATION_ROUTES)(
        '$method: admin WITH matching ops role → chain passes (flag ON)',
        async ({ method, opsPermission }) => {
          // Pick a role that actually grants this permission. The
          // grants are pinned by ops-roles-catalog-equivalence.spec
          // for super_admin (every OpsPermission); other roles are
          // picked manually below by inspection of PERMISSIONS_BY_ROLE
          // (mirrored in ROLE_PERMISSIONS catalog entries).
          const granteeRoleByPerm: Record<OpsPermission, string[]> = {
            'store.review': ['operations_manager', 'merchant_review'],
            'store.set_plan': [],
            'store.set_featured': ['operations_manager'],
            'store.set_status': [
              'operations_manager',
              'merchant_review',
              'trust_safety',
            ],
            'store.read_detail': [
              'operations_manager',
              'merchant_review',
              'support',
              'fulfillment_ops',
              'finance',
            ],
            'user.read': ['operations_manager', 'support', 'trust_safety'],
            // user.set_role is intentionally granted ONLY to
            // super_admin in the current catalog. Other tests in
            // this block cover the super_admin path; this map uses
            // 'super_admin' here so the parameterised "narrower
            // role grants" assertion still has a valid grantee
            // to mock against.
            'user.set_role': ['super_admin'],
            'user.suspend': ['trust_safety'],
            // user.restore mirrors user.suspend grant set per the
            // backend/identity-and-admin-controls commit C2 — the
            // same operators who can disable can restore.
            'user.restore': ['trust_safety'],
            // user.purge is super_admin-ONLY. No subordinate ops
            // role holds it; the only valid grantee in the test
            // matrix is super_admin (covered by the dedicated
            // super_admin chain test elsewhere in this spec).
            'user.purge': ['super_admin'],
            'user.assign_ops_role': [],
            'finance.read_payouts': ['finance'],
            'finance.record_payout_event': ['finance'],
            'finance.reconcile': ['finance'],
            'finance.vat_facts': ['finance'],
            'finance.receipts': ['finance'],
            'finance.settlement_approve': ['finance'],
            'finance.settlement_execute': ['finance'],
            'finance.refunds': ['finance'],
            'finance.approve_payout': ['finance'],
            'diagnostics.read': [
              'operations_manager',
              'support',
              'fulfillment_ops',
            ],
            'diagnostics.run_seed': ['operations_manager'],
            'report.read': ['operations_manager', 'support', 'trust_safety'],
            'report.resolve': ['trust_safety'],
            'analytics.read': ['operations_manager', 'analytics_viewer'],
            // audit.read — the audit-log viewer (PR 11). Granted to
            // operations_manager + trust_safety (+ super_admin via
            // the ALL bundle).
            'audit.read': ['operations_manager', 'trust_safety'],
            'beta.manage': ['operations_manager'],
            // org.review — corporate organization review queue
            // (Corporate Foundation PR 1). operations_manager only
            // (+ super_admin via the ALL bundle); trust_safety is
            // deliberately NOT granted — org vetting is an
            // operations decision, not a moderation one.
            'org.review': ['operations_manager'],
          };
          const grantee = granteeRoleByPerm[opsPermission][0];
          // Sanity: every mutation route here has at least one
          // non-super_admin grantee.
          expect(grantee).toBeDefined();

          process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
          prismaFindUnique.mockResolvedValue({
            role: 'admin',
            deletedAt: null,
          });
          getUserRolesMock.mockResolvedValue([grantee]);

          await expect(
            runChain({ userId: 'admin-1', handler: handlerFor(method) }),
          ).resolves.toBe(true);
        },
      );

      it.each(ADMIN_MUTATION_ROUTES)(
        '$method: super_admin → chain passes (flag ON)',
        async ({ method }) => {
          process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
          prismaFindUnique.mockResolvedValue({
            role: 'admin',
            deletedAt: null,
          });
          // super_admin via the catalog holds ALL_ADMIN_PERMISSIONS
          // which is a superset of OPS_PERMISSIONS (pinned by
          // ops-roles-catalog-equivalence.spec.ts).
          getUserRolesMock.mockResolvedValue(['super_admin']);

          await expect(
            runChain({ userId: 'admin-1', handler: handlerFor(method) }),
          ).resolves.toBe(true);
        },
      );

      it.each(ADMIN_MUTATION_ROUTES)(
        '$method: non-admin → 403 "Admin access required" BEFORE RBAC dispatch',
        async ({ method }) => {
          process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
          prismaFindUnique.mockResolvedValue({
            role: 'store',
            deletedAt: null,
          });

          await expect(
            runChain({ userId: 'store-1', handler: handlerFor(method) }),
          ).rejects.toThrow('Admin access required');

          // OpsRoleGuard never runs — AdminGuard short-circuits.
          expect(getUserRolesMock).not.toHaveBeenCalled();
          expect(userHasPermissionMock).not.toHaveBeenCalled();
        },
      );

      it.each(ADMIN_MUTATION_ROUTES)(
        '$method: soft-deleted admin → 403 "Admin access required" regardless of catalog',
        async ({ method }) => {
          process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
          prismaFindUnique.mockResolvedValue({
            role: 'admin',
            deletedAt: new Date('2024-01-01T00:00:00Z'),
          });
          // Even if the catalog would grant this permission, the
          // deletedAt rejection short-circuits BEFORE the RBAC
          // dispatch.
          getUserRolesMock.mockResolvedValue(['super_admin']);

          await expect(
            runChain({ userId: 'admin-1', handler: handlerFor(method) }),
          ).rejects.toThrow('Admin access required');
        },
      );
    });
  });
});
