// Phase 6.7 — social-handle search privacy hardening.
//
// Locks down the architectural shift from "autocomplete-style
// substring search" (which behaved like social-media-style
// discovery) to "intentional exact-match identity lookup":
//
//   1. Below-min-length queries hit no DB.
//   2. The query is normalized (strip @, lowercase, collapse
//      whitespace) the same way SocialAccountsService.normalizeHandle
//      does at WRITE time — guarantees query / storage agreement.
//   3. The DB query is exact-match on `handle`, NOT contains. Take
//      capped at 1 (the @@unique([platform, handle]) constraint
//      means at most one hit anyway; explicit cap defends against
//      future widening).
//   4. matchedValue is empty — the handle is never echoed back, so
//      an attacker can't probe casing / formatting variants.

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
    user: { findMany: jest.fn().mockResolvedValue([]) },
    socialAccount: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const VIEWER_ID = 'viewer';
const PLATFORMS = [
  'snapchat',
  'tiktok',
  'instagram',
  'x',
  'facebook',
  'youtube',
  'threads',
  'telegram',
] as const;

describe('UsersService.searchUsers — social handle hardening', () => {
  let service: UsersService;
  let prisma: MockPrisma;
  let blocks: { listExcludedIds: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    blocks = { listExcludedIds: jest.fn().mockResolvedValue([]) };

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

  describe('min-length gate (no DB call below floor)', () => {
    it('returns [] for an empty query', async () => {
      const out = await service.searchUsers(VIEWER_ID, '', 'snapchat');
      expect(out).toEqual([]);
      expect(prisma.socialAccount.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for a single-character query', async () => {
      const out = await service.searchUsers(VIEWER_ID, 'a', 'snapchat');
      expect(out).toEqual([]);
      expect(prisma.socialAccount.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for "@" alone (normalizes to empty)', async () => {
      const out = await service.searchUsers(VIEWER_ID, '@', 'tiktok');
      expect(out).toEqual([]);
      expect(prisma.socialAccount.findMany).not.toHaveBeenCalled();
    });

    it('returns [] for whitespace-only query', async () => {
      const out = await service.searchUsers(VIEWER_ID, '   ', 'instagram');
      expect(out).toEqual([]);
      expect(prisma.socialAccount.findMany).not.toHaveBeenCalled();
    });
  });

  describe('exact-match DB query (when shape passes)', () => {
    for (const platform of PLATFORMS) {
      it(`uses exact-match (not contains) on ${platform}`, async () => {
        await service.searchUsers(VIEWER_ID, 'sarah_q', platform);
        expect(prisma.socialAccount.findMany).toHaveBeenCalledTimes(1);
        const call = prisma.socialAccount.findMany.mock.calls[0][0];
        // Critical assertion: handle is a literal string, NOT a
        // { contains: ..., mode: 'insensitive' } object. A regression
        // to substring matching would change this assertion.
        expect(call.where.handle).toBe('sarah_q');
        expect(call.where.platform).toBe(platform);
        expect(call.take).toBe(1);
      });
    }

    it('strips the leading @ before matching', async () => {
      await service.searchUsers(VIEWER_ID, '@sarah_q', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      expect(call.where.handle).toBe('sarah_q');
    });

    it('strips multiple leading @s', async () => {
      await service.searchUsers(VIEWER_ID, '@@sarah_q', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      expect(call.where.handle).toBe('sarah_q');
    });

    it('lowercases the query (matches stored normalization)', async () => {
      // Stored handles are lowercased by SocialAccountsService.
      // The query must lowercase too or exact-match misses hits.
      await service.searchUsers(VIEWER_ID, 'Sarah_Q', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      expect(call.where.handle).toBe('sarah_q');
    });

    it('collapses internal whitespace before matching', async () => {
      // A paste like "sarah _q" normalizes to "sarah_q" (no spaces).
      // This matches storage-side normalization exactly.
      await service.searchUsers(VIEWER_ID, '@sarah _q', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      expect(call.where.handle).toBe('sarah_q');
    });

    it('excludes the viewer themselves from results', async () => {
      await service.searchUsers(VIEWER_ID, 'sarah_q', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      expect(call.where.userId.not).toBe(VIEWER_ID);
    });

    it('respects the bidirectional block list', async () => {
      blocks.listExcludedIds.mockResolvedValueOnce(['blocked-1']);
      await service.searchUsers(VIEWER_ID, 'sarah_q', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      expect(call.where.userId.notIn).toEqual(['blocked-1']);
    });

    it('returns matchedField=<platform> with an empty matchedValue', async () => {
      // matchedValue must be empty so an attacker can't probe casing
      // variants. The searcher already typed the handle; echoing it
      // back gives them nothing new.
      prisma.socialAccount.findMany.mockResolvedValueOnce([
        {
          platform: 'snapchat',
          user: {
            id: 'u1',
            qiftUsername: 'sarah',
            fullName: 'Sarah Q',
            avatarUrl: null,
          },
        },
      ]);
      const out = await service.searchUsers(VIEWER_ID, 'sarah_q', 'snapchat');
      expect(out).toHaveLength(1);
      expect(out[0].matchedField).toBe('snapchat');
      expect(out[0].matchedValue).toBe('');
    });

    it('returns [] when no SocialAccount matches the exact handle', async () => {
      prisma.socialAccount.findMany.mockResolvedValueOnce([]);
      const out = await service.searchUsers(
        VIEWER_ID,
        'nonexistent',
        'snapchat',
      );
      expect(out).toEqual([]);
    });
  });

  describe('regression: no substring leakage', () => {
    it('does NOT use the contains predicate (defends against a substring regression)', async () => {
      await service.searchUsers(VIEWER_ID, 'sarah', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      // The previous (autocomplete-style) behaviour was:
      //   handle: { contains: 'sarah', mode: 'insensitive' }
      // If this assertion ever fails, the substring autocomplete
      // surface has come back. The exact-match privacy invariant
      // is what makes the Phase 6.7 refinement load-bearing.
      expect(typeof call.where.handle).toBe('string');
      expect(call.where.handle).not.toHaveProperty('contains');
    });

    it('caps result count at 1 (defence-in-depth against future widening)', async () => {
      await service.searchUsers(VIEWER_ID, 'sarah', 'snapchat');
      const call = prisma.socialAccount.findMany.mock.calls[0][0];
      expect(call.take).toBe(1);
    });
  });
});
