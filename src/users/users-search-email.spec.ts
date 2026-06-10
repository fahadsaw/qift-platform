// QA-audit follow-up: email-discovery privacy hardening.
//
// Locks down the four behaviours that close the substring /
// enumeration loopholes the audit surfaced:
//   1. Substring queries never hit the DB.
//   2. Malformed "email" queries (no @, multiple @, missing
//      domain dot) never hit the DB.
//   3. The DB query is exact-match + `allowEmailDiscovery: true` +
//      `profileVisibility: { not: 'private' }` — three gates
//      layered on top of the unique constraint, so a hit can be
//      returned only when the owner explicitly opted in.
//   4. Result rows never echo the email back (`matchedValue: ''`).
//
// We mock PrismaService + BlocksService directly so the assertion
// is on the where-clause Prisma actually receives. No real DB.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from '../blocks/blocks.service';
import { OtpService } from '../otp/otp.service';
import { AuditService } from '../audit/audit.service';

type MockPrisma = {
  user: { findMany: jest.Mock };
  socialAccount: { findMany: jest.Mock };
};

function createPrismaMock(): MockPrisma {
  return {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    socialAccount: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

describe('UsersService.searchUsers — email discovery hardening', () => {
  let service: UsersService;
  let prisma: MockPrisma;
  let blocks: { listExcludedIds: jest.Mock };

  const VIEWER_ID = 'viewer';

  beforeEach(async () => {
    prisma = createPrismaMock();
    blocks = {
      listExcludedIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: BlocksService, useValue: blocks },
        // Change-phone deps (PR 5) — not exercised by this suite.
        { provide: OtpService, useValue: {} },
        { provide: AuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('shape validation (no DB call when malformed)', () => {
    it('returns [] for a bare substring with no @', async () => {
      const out = await service.searchUsers(VIEWER_ID, 'gmail', 'email');
      expect(out).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for a domain-only query (no local part)', async () => {
      const out = await service.searchUsers(VIEWER_ID, '@gmail.com', 'email');
      expect(out).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for a local-part-only query (no domain)', async () => {
      const out = await service.searchUsers(VIEWER_ID, 'user@', 'email');
      expect(out).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for a multi-@ query', async () => {
      const out = await service.searchUsers(
        VIEWER_ID,
        'user@@gmail.com',
        'email',
      );
      expect(out).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for a query missing the domain dot', async () => {
      const out = await service.searchUsers(
        VIEWER_ID,
        'user@localhost',
        'email',
      );
      expect(out).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for a one-char query (below the global min-length floor)', async () => {
      const out = await service.searchUsers(VIEWER_ID, 'a', 'email');
      // The min-length gate is now type-aware — phone + email skip
      // it because they have their own exact-match validators. But
      // 'a' still fails the email-shape check, so still [].
      expect(out).toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('exact-match DB query (when shape passes)', () => {
    it('calls findMany with exact-match + allowEmailDiscovery + non-private', async () => {
      await service.searchUsers(VIEWER_ID, 'sarah@example.com', 'email');

      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      const call = prisma.user.findMany.mock.calls[0][0];
      // Exact email match — never `contains`.
      expect(call.where.email).toBe('sarah@example.com');
      // Default-deny gate.
      expect(call.where.allowEmailDiscovery).toBe(true);
      // Private-profile gate.
      expect(call.where.profileVisibility).toEqual({ not: 'private' });
      // take=1 — the email column is unique so one hit max anyway,
      // but the explicit take guards against accidental future
      // widening.
      expect(call.take).toBe(1);
    });

    it('lower-cases the query before querying (rfc-friendly)', async () => {
      await service.searchUsers(VIEWER_ID, 'Sarah@Example.COM', 'email');
      const call = prisma.user.findMany.mock.calls[0][0];
      expect(call.where.email).toBe('sarah@example.com');
    });

    it('excludes the viewer themselves from results', async () => {
      await service.searchUsers(VIEWER_ID, 'self@example.com', 'email');
      const call = prisma.user.findMany.mock.calls[0][0];
      expect(call.where.id.not).toBe(VIEWER_ID);
    });

    it('respects the block list (excluded ids)', async () => {
      blocks.listExcludedIds.mockResolvedValueOnce(['blocked-1', 'blocked-2']);
      await service.searchUsers(VIEWER_ID, 'target@example.com', 'email');
      const call = prisma.user.findMany.mock.calls[0][0];
      expect(call.where.id.notIn).toEqual(['blocked-1', 'blocked-2']);
    });

    it('returns matchedField=email with an empty matchedValue', async () => {
      prisma.user.findMany.mockResolvedValueOnce([
        {
          id: 'u1',
          qiftUsername: 'sarah',
          fullName: 'Sarah Q',
          avatarUrl: null,
        },
      ]);
      const out = await service.searchUsers(
        VIEWER_ID,
        'sarah@example.com',
        'email',
      );
      expect(out).toHaveLength(1);
      expect(out[0].matchedField).toBe('email');
      // matchedValue MUST be empty — the email is never echoed back.
      expect(out[0].matchedValue).toBe('');
    });

    it('returns [] when no user opted in (allowEmailDiscovery=false → no row matches)', async () => {
      prisma.user.findMany.mockResolvedValueOnce([]);
      const out = await service.searchUsers(
        VIEWER_ID,
        'sarah@example.com',
        'email',
      );
      expect(out).toEqual([]);
    });
  });
});
