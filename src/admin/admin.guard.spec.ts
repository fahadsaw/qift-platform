// Unit tests for AdminGuard — PR B-4 (first guard migration).
//
// First guard test file in the backend. The pattern established here
// (Prisma mock via direct construction, fake ExecutionContext, env-
// var save/restore between cases) is the template subsequent guard
// migrations should follow.
//
// COVERAGE GOAL
// Prove that the dual-path RBAC dispatch added in PR B-4 produces
// IDENTICAL canActivate outcomes for every realistic user state,
// across both flag states. The four pre-existing gates of AdminGuard
// stay intact:
//   1. Missing req.user / userId → throw (no DB lookup)
//   2. User not found in DB → throw
//   3. Soft-deleted user → throw (BEFORE RBAC dispatch)
//   4. Role check → throw (the only line the migration touched)
//
// Plus: ensure DB reload happens on every canActivate call (the
// load-bearing invariant — JWT payload is NOT trusted for role).

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from './admin.guard';

// Test helpers ---------------------------------------------------------

function makeContext(userId: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: userId === undefined ? undefined : { userId },
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeContextNoUserField(): ExecutionContext {
  // Edge case: request object has no `user` property at all (as
  // opposed to `user: undefined`). The optional-chaining in the
  // guard handles both identically.
  return {
    switchToHttp: () => ({
      getRequest: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------

describe('AdminGuard', () => {
  let prismaFindUnique: jest.Mock;
  let guard: AdminGuard;

  const ORIGINAL_RBAC = process.env.RBAC_PERMISSION_CHECKS_ENABLED;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    prismaFindUnique = jest.fn();
    const fakePrisma = { user: { findUnique: prismaFindUnique } };
    guard = new AdminGuard(fakePrisma as unknown as PrismaService);
  });

  afterEach(() => {
    // Hermetic env restoration — same pattern as
    // permission-checks-flag.spec.ts. Crucial because sibling test
    // suites depend on NODE_ENV === 'test'.
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

  describe('flag OFF (legacy path: user.role === "admin")', () => {
    beforeEach(() => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
    });

    it('admin user → returns true', async () => {
      prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
      const result = await guard.canActivate(makeContext('admin-1'));
      expect(result).toBe(true);
    });

    it('store user → throws ForbiddenException("Admin access required")', async () => {
      prismaFindUnique.mockResolvedValue({ role: 'store', deletedAt: null });
      await expect(
        guard.canActivate(makeContext('store-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(makeContext('store-1'))).rejects.toThrow(
        'Admin access required',
      );
    });

    it('regular user → throws ForbiddenException', async () => {
      prismaFindUnique.mockResolvedValue({ role: 'user', deletedAt: null });
      await expect(
        guard.canActivate(makeContext('user-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('soft-deleted admin → throws (rejection happens BEFORE RBAC dispatch)', async () => {
      prismaFindUnique.mockResolvedValue({
        role: 'admin',
        deletedAt: new Date('2025-01-01T00:00:00Z'),
      });
      await expect(
        guard.canActivate(makeContext('admin-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('user not found in DB → throws', async () => {
      prismaFindUnique.mockResolvedValue(null);
      await expect(
        guard.canActivate(makeContext('ghost-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing req.user.userId → throws without DB lookup', async () => {
      await expect(
        guard.canActivate(makeContext(undefined)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prismaFindUnique).not.toHaveBeenCalled();
    });

    it('missing req.user field entirely → throws without DB lookup', async () => {
      await expect(
        guard.canActivate(makeContextNoUserField()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prismaFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('flag ON (new RBAC path: hasPermission(user, "admin.access"))', () => {
    beforeEach(() => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
    });

    it('admin user → returns true (legacy_admin holds admin.access)', async () => {
      prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
      const result = await guard.canActivate(makeContext('admin-1'));
      expect(result).toBe(true);
    });

    it('store user → throws (legacy_store does NOT hold admin.access)', async () => {
      prismaFindUnique.mockResolvedValue({ role: 'store', deletedAt: null });
      await expect(
        guard.canActivate(makeContext('store-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guard.canActivate(makeContext('store-1'))).rejects.toThrow(
        'Admin access required',
      );
    });

    it('regular user → throws (legacy_user does NOT hold admin.access)', async () => {
      prismaFindUnique.mockResolvedValue({ role: 'user', deletedAt: null });
      await expect(
        guard.canActivate(makeContext('user-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('soft-deleted admin → throws (rejection happens BEFORE RBAC dispatch)', async () => {
      // Critical regression check: even when the flag is ON and the
      // role is 'admin' (which would otherwise grant admin.access),
      // the deletedAt rejection short-circuits BEFORE the RBAC
      // branch. Soft-deleted admins must never authorize.
      prismaFindUnique.mockResolvedValue({
        role: 'admin',
        deletedAt: new Date('2025-01-01T00:00:00Z'),
      });
      await expect(
        guard.canActivate(makeContext('admin-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('user not found in DB → throws', async () => {
      prismaFindUnique.mockResolvedValue(null);
      await expect(
        guard.canActivate(makeContext('ghost-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing req.user.userId → throws without DB lookup', async () => {
      await expect(
        guard.canActivate(makeContext(undefined)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prismaFindUnique).not.toHaveBeenCalled();
    });

    it('missing req.user field entirely → throws without DB lookup', async () => {
      await expect(
        guard.canActivate(makeContextNoUserField()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prismaFindUnique).not.toHaveBeenCalled();
    });

    it('unknown role string → throws (legacyRoleFor falls back to legacy_user)', async () => {
      // Defense-in-depth: if a User row somehow ends up with a role
      // value outside the documented enum, the RBAC path falls back
      // to legacy_user and correctly denies admin access.
      prismaFindUnique.mockResolvedValue({
        role: 'rogue_value',
        deletedAt: null,
      });
      await expect(
        guard.canActivate(makeContext('admin-1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('exception message identical across both branches', () => {
    it('flag OFF + store throws exact message "Admin access required"', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      prismaFindUnique.mockResolvedValue({ role: 'store', deletedAt: null });
      await expect(guard.canActivate(makeContext('store-1'))).rejects.toThrow(
        'Admin access required',
      );
    });

    it('flag ON + store throws exact message "Admin access required"', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      prismaFindUnique.mockResolvedValue({ role: 'store', deletedAt: null });
      await expect(guard.canActivate(makeContext('store-1'))).rejects.toThrow(
        'Admin access required',
      );
    });
  });

  describe('DB reload behaviour preserved (JWT NOT trusted for role)', () => {
    it('flag OFF: reloads on every canActivate call', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
      await guard.canActivate(makeContext('admin-1'));
      await guard.canActivate(makeContext('admin-1'));
      await guard.canActivate(makeContext('admin-1'));
      expect(prismaFindUnique).toHaveBeenCalledTimes(3);
    });

    it('flag ON: reloads on every canActivate call', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
      await guard.canActivate(makeContext('admin-1'));
      await guard.canActivate(makeContext('admin-1'));
      await guard.canActivate(makeContext('admin-1'));
      expect(prismaFindUnique).toHaveBeenCalledTimes(3);
    });

    it('queries by userId and selects only role + deletedAt', async () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
      await guard.canActivate(makeContext('user-123'));
      expect(prismaFindUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        select: { role: true, deletedAt: true },
      });
    });

    it('query shape is identical when flag is ON', async () => {
      // The RBAC migration must not change the DB query — only the
      // post-load authorization decision.
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      prismaFindUnique.mockResolvedValue({ role: 'admin', deletedAt: null });
      await guard.canActivate(makeContext('user-456'));
      expect(prismaFindUnique).toHaveBeenCalledWith({
        where: { id: 'user-456' },
        select: { role: true, deletedAt: true },
      });
    });
  });
});
