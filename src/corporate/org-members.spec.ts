// Org seat management unit tests — Corporate Foundation PR 7a.
//
// The two demanded blocks are first-class:
//
//   * TENANT ISOLATION — member reads/revokes are keyed to the
//     caller's org; a seat id from another org reads as missing.
//   * CANNOT SELF-ELEVATE — 'owner' is never grantable, unknown
//     roles are rejected, and an ACTIVE seat (your own included)
//     can never be re-added with a different role. Role changes are
//     revoke-then-re-add, both owner-only actions.
//
// Plus: username resolution (strip @, lowercase, deleted users
// excluded), revoked-seat revival, owner irrevocability (which is
// what makes "owner cannot revoke themselves" structural), and the
// audit rows for add/revoke.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { OrgService } from './org.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type PrismaMock = {
  organization: { findUnique: jest.Mock };
  orgUser: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  user: { findFirst: jest.Mock; findMany: jest.Mock };
  $transaction: jest.Mock;
};

describe('OrgService — seat management (PR 7a)', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let service: OrgService;

  beforeEach(() => {
    prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue(null) },
      orgUser: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'seat-new',
            userId: data.userId,
            role: data.role,
            createdAt: new Date(),
          }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'seat-revived',
            userId: 'u-target',
            role: data.role,
            createdAt: new Date(),
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'u-target', qiftUsername: 'sara' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockImplementation((fn) => fn(prisma)),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new OrgService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ═════════════════════════════════════════════════════════════════
  describe('cannot self-elevate', () => {
    it.each(['owner', 'super_admin', 'root', ''])(
      'role %j is never grantable',
      async (role) => {
        await expect(
          service.addMember('owner-1', 'org-1', {
            qiftUsername: 'sara',
            role,
          }),
        ).rejects.toThrow('member_role_invalid');
        expect(prisma.orgUser.create).not.toHaveBeenCalled();
        expect(prisma.orgUser.update).not.toHaveBeenCalled();
      },
    );

    it('an ACTIVE seat can never be re-added with a different role — self included', async () => {
      // The owner tries to re-add themselves as... anything.
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        qiftUsername: 'theowner',
      });
      prisma.orgUser.findUnique.mockResolvedValue({
        id: 'seat-owner',
        revokedAt: null,
      });
      try {
        await service.addMember('owner-1', 'org-1', {
          qiftUsername: 'theowner',
          role: 'admin',
        });
        throw new Error('expected addMember to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(409);
        expect(
          ((e as HttpException).getResponse() as { code: string }).code,
        ).toBe('member_already_seated');
      }
      expect(prisma.orgUser.update).not.toHaveBeenCalled();
      expect(prisma.orgUser.create).not.toHaveBeenCalled();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('tenant isolation', () => {
    it('seat lookups on add are keyed to THIS org', async () => {
      await service.addMember('owner-1', 'org-1', {
        qiftUsername: 'sara',
        role: 'approver',
      });
      expect(prisma.orgUser.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId_userId: { orgId: 'org-1', userId: 'u-target' } },
        }),
      );
    });

    it('a seat id from another org reads as missing on revoke', async () => {
      prisma.orgUser.findFirst.mockResolvedValue(null);
      await expect(
        service.revokeMember('owner-1', 'org-1', 'seat-of-org-2'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.orgUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'seat-of-org-2', orgId: 'org-1', revokedAt: null },
        }),
      );
      expect(prisma.orgUser.updateMany).not.toHaveBeenCalled();
    });

    it('listMembers is scoped to the org and active seats only', async () => {
      await service.listMembers('org-1');
      expect(prisma.orgUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: 'org-1', revokedAt: null },
        }),
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('addMember', () => {
    it('resolves the username: strips @, lowercases, excludes deleted users', async () => {
      await service.addMember('owner-1', 'org-1', {
        qiftUsername: ' @Sara ',
        role: 'approver',
      });
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { qiftUsername: 'sara', deletedAt: null },
        }),
      );
    });

    it('404s on an unknown username', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.addMember('owner-1', 'org-1', {
          qiftUsername: 'ghost',
          role: 'viewer',
        }),
      ).rejects.toThrow('user_not_found');
    });

    it('creates a fresh seat stamped with the inviter, active immediately', async () => {
      const seat = await service.addMember('owner-1', 'org-1', {
        qiftUsername: 'sara',
        role: 'approver',
      });
      expect(prisma.orgUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orgId: 'org-1',
            userId: 'u-target',
            role: 'approver',
            invitedBy: 'owner-1',
            acceptedAt: expect.any(Date),
          }),
        }),
      );
      expect(seat.qiftUsername).toBe('sara');
    });

    it('REVIVES a revoked seat with the new role instead of duplicating', async () => {
      prisma.orgUser.findUnique.mockResolvedValue({
        id: 'seat-old',
        revokedAt: new Date('2026-01-01'),
      });
      await service.addMember('owner-1', 'org-1', {
        qiftUsername: 'sara',
        role: 'viewer',
      });
      expect(prisma.orgUser.create).not.toHaveBeenCalled();
      expect(prisma.orgUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'seat-old' },
          data: expect.objectContaining({
            role: 'viewer',
            revokedAt: null,
            invitedBy: 'owner-1',
          }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'org.member.add',
          metadata: expect.objectContaining({ revived: true }),
        }),
      );
    });

    it('audits org.member.add with seat + role', async () => {
      await service.addMember('owner-1', 'org-1', {
        qiftUsername: 'sara',
        role: 'admin',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'owner-1',
          actorType: 'user',
          action: 'org.member.add',
          targetType: 'organization',
          targetId: 'org-1',
          metadata: expect.objectContaining({
            memberUserId: 'u-target',
            role: 'admin',
          }),
        }),
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('revokeMember', () => {
    it('the owner cannot revoke themselves', async () => {
      prisma.orgUser.findFirst.mockResolvedValue({
        id: 'seat-owner',
        userId: 'owner-1',
        role: 'owner',
      });
      await expect(
        service.revokeMember('owner-1', 'org-1', 'seat-owner'),
      ).rejects.toThrow('cannot_revoke_self');
      expect(prisma.orgUser.updateMany).not.toHaveBeenCalled();
    });

    it('the owner SEAT is irrevocable even if a future second owner tried', async () => {
      prisma.orgUser.findFirst.mockResolvedValue({
        id: 'seat-owner',
        userId: 'someone-else',
        role: 'owner',
      });
      await expect(
        service.revokeMember('owner-1', 'org-1', 'seat-owner'),
      ).rejects.toThrow('cannot_revoke_owner');
    });

    it('soft-revokes via a conditional update and audits it', async () => {
      prisma.orgUser.findFirst.mockResolvedValue({
        id: 'seat-2',
        userId: 'u-target',
        role: 'approver',
      });
      await service.revokeMember('owner-1', 'org-1', 'seat-2');
      expect(prisma.orgUser.updateMany).toHaveBeenCalledWith({
        where: { id: 'seat-2', orgId: 'org-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'org.member.revoke',
          metadata: expect.objectContaining({
            seatId: 'seat-2',
            memberUserId: 'u-target',
          }),
        }),
      );
    });

    it('a lost revoke race (count 0) reads as missing, no audit', async () => {
      prisma.orgUser.findFirst.mockResolvedValue({
        id: 'seat-2',
        userId: 'u-target',
        role: 'viewer',
      });
      prisma.orgUser.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.revokeMember('owner-1', 'org-1', 'seat-2'),
      ).rejects.toThrow('member_not_found');
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('listMembers', () => {
    it('joins usernames manually; a purged member renders with null username', async () => {
      prisma.orgUser.findMany.mockResolvedValue([
        { id: 's1', userId: 'u-1', role: 'owner', invitedBy: null, acceptedAt: new Date(), createdAt: new Date() },
        { id: 's2', userId: 'u-purged', role: 'viewer', invitedBy: 'u-1', acceptedAt: new Date(), createdAt: new Date() },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u-1', qiftUsername: 'theowner' },
      ]);
      const members = await service.listMembers('org-1');
      expect(members[0].qiftUsername).toBe('theowner');
      expect(members[1].qiftUsername).toBeNull();
    });
  });

  it('member errors use BadRequest for validation, not 500s', async () => {
    await expect(
      service.addMember('owner-1', 'org-1', { role: 'admin' }),
    ).rejects.toThrow(BadRequestException);
  });
});
