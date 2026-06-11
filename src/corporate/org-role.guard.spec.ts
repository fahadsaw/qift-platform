// OrgRoleGuard unit tests — the org-plane tenant boundary
// (Corporate Foundation PR 1).
//
// These are the TENANT-ISOLATION tests the Corporate Core v2 plan
// names as a first-class deliverable: a seat in org A must not open
// org B, a revoked seat is dead, a non-member sees 404 (never 403 —
// anti-enumeration), and role checks only start once membership is
// proven. Also covers the org-roles helpers.

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PrismaService } from '../prisma/prisma.service';
import { OrgRoleGuard } from './org-role.guard';
import { isOrgRole, orgRoleSatisfies, type OrgRole } from './org-roles';

type Req = {
  user?: { userId: string };
  params?: Record<string, string>;
  orgContext?: unknown;
};

const makeCtx = (req: Req): ExecutionContext =>
  ({
    getHandler: () => function handler() {},
    getClass: () => class Host {},
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('org-roles helpers', () => {
  it('isOrgRole accepts the four roles and nothing else', () => {
    for (const r of ['owner', 'admin', 'approver', 'viewer']) {
      expect(isOrgRole(r)).toBe(true);
    }
    expect(isOrgRole('super_admin')).toBe(false); // ops plane never leaks in
    expect(isOrgRole('')).toBe(false);
  });

  it('owner satisfies every allow-list, even an empty one', () => {
    expect(orgRoleSatisfies('owner', ['admin'])).toBe(true);
    expect(orgRoleSatisfies('owner', [])).toBe(true);
  });

  it('non-owner roles are explicit-list only — no hierarchy ladder', () => {
    expect(orgRoleSatisfies('admin', ['admin'])).toBe(true);
    expect(orgRoleSatisfies('admin', ['approver'])).toBe(false);
    expect(orgRoleSatisfies('approver', ['admin', 'approver'])).toBe(true);
    expect(orgRoleSatisfies('viewer', ['admin'])).toBe(false);
  });
});

describe('OrgRoleGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: { orgUser: { findFirst: jest.Mock } };
  let guard: OrgRoleGuard;

  const requireRoles = (roles: OrgRole[] | undefined) =>
    reflector.getAllAndOverride.mockReturnValue(roles);

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    prisma = { orgUser: { findFirst: jest.fn().mockResolvedValue(null) } };
    guard = new OrgRoleGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('passes undecorated routes without touching the DB', async () => {
    requireRoles(undefined);
    const req: Req = { user: { userId: 'u1' } };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(prisma.orgUser.findFirst).not.toHaveBeenCalled();
  });

  it('fails CLOSED (404) when a decorated route has no :orgId param', async () => {
    requireRoles([]);
    const req: Req = { user: { userId: 'u1' }, params: {} };
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.orgUser.findFirst).not.toHaveBeenCalled();
  });

  it('fails CLOSED (404) when req.user is missing', async () => {
    requireRoles([]);
    const req: Req = { params: { orgId: 'org-a' } };
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('non-member gets 404 — indistinguishable from "no such org"', async () => {
    requireRoles([]);
    const req: Req = { user: { userId: 'u1' }, params: { orgId: 'org-a' } };
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      'org_not_found',
    );
  });

  it('TENANT ISOLATION: a seat in org A cannot open org B', async () => {
    requireRoles([]);
    // The seat lookup is scoped to the REQUESTED org — membership in
    // any other org never enters the query, so it can never satisfy it.
    prisma.orgUser.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.orgId === 'org-a' && where.userId === 'u1'
          ? { id: 'seat-a', role: 'owner' }
          : null,
      ),
    );
    const reqB: Req = { user: { userId: 'u1' }, params: { orgId: 'org-b' } };
    await expect(guard.canActivate(makeCtx(reqB))).rejects.toThrow(
      'org_not_found',
    );
    expect(prisma.orgUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-b', userId: 'u1', revokedAt: null },
      }),
    );
    // Same user, their OWN org → passes.
    const reqA: Req = { user: { userId: 'u1' }, params: { orgId: 'org-a' } };
    await expect(guard.canActivate(makeCtx(reqA))).resolves.toBe(true);
  });

  it('revoked seats are dead — the lookup itself requires revokedAt null', async () => {
    requireRoles([]);
    const req: Req = { user: { userId: 'u1' }, params: { orgId: 'org-a' } };
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.orgUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
      }),
    );
  });

  it('wrong role with a valid seat is 403 (member already knows the org exists)', async () => {
    requireRoles(['admin']);
    prisma.orgUser.findFirst.mockResolvedValue({
      id: 'seat-1',
      role: 'viewer',
    });
    const req: Req = { user: { userId: 'u1' }, params: { orgId: 'org-a' } };
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      'org_role_insufficient',
    );
  });

  it('owner satisfies any required role', async () => {
    requireRoles(['admin']);
    prisma.orgUser.findFirst.mockResolvedValue({
      id: 'seat-1',
      role: 'owner',
    });
    const req: Req = { user: { userId: 'u1' }, params: { orgId: 'org-a' } };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
  });

  it('empty decorator (@RequireOrgRole()) admits any active seat', async () => {
    requireRoles([]);
    prisma.orgUser.findFirst.mockResolvedValue({
      id: 'seat-1',
      role: 'viewer',
    });
    const req: Req = { user: { userId: 'u1' }, params: { orgId: 'org-a' } };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
  });

  it('attaches the verified orgContext for downstream handlers', async () => {
    requireRoles(['admin']);
    prisma.orgUser.findFirst.mockResolvedValue({
      id: 'seat-1',
      role: 'admin',
    });
    const req: Req = { user: { userId: 'u1' }, params: { orgId: 'org-a' } };
    await guard.canActivate(makeCtx(req));
    expect(req.orgContext).toEqual({
      orgId: 'org-a',
      role: 'admin',
      orgUserId: 'seat-1',
    });
  });
});
