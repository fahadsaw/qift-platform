// InvitesService specs — locks down the invariants that matter:
//
//   1. Privacy: raw channel value never persists; public token
//      resolution returns no PII; non-existent / revoked /
//      expired tokens all return isValid=false without revealing
//      which case happened.
//
//   2. Rate-limit: 21st invite from the same sender within 24h
//      throws 429.
//
//   3. Lifecycle: revoke is ownership-gated + race-safe (only
//      transitions 'active' rows); expired rows surface as
//      'expired' in the sender list view without a DB mutation.
//
//   4. Provider integration: the manual-share payload (Arabic +
//      English templates, platformOpenUrl) is emitted exactly
//      as the provider specifies, with no leakage of recipient
//      identity (we never had it; the templates don't reference
//      anything beyond inviteUrl).

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { InvitesService } from './invites.service';
import { PrismaService } from '../prisma/prisma.service';

type MockPrisma = {
  invite: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
};

function createPrismaMock(): MockPrisma {
  return {
    invite: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

const SENDER_ID = 'user_sender';

describe('InvitesService', () => {
  let service: InvitesService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvitesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<InvitesService>(InvitesService);
  });

  describe('create', () => {
    function setupCreateOk() {
      prisma.invite.count.mockResolvedValueOnce(0);
      prisma.invite.create.mockImplementation(({ data }: { data: any }) =>
        Promise.resolve({
          id: 'inv_1',
          token: data.token,
          channel: data.channel,
          platform: data.platform ?? null,
          expiresAt: data.expiresAt,
        }),
      );
    }

    it('mints an invite with a random opaque token + 14d expiry', async () => {
      setupCreateOk();
      const out = await service.create(SENDER_ID, { channel: 'phone' });
      expect(out.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(out.channel).toBe('phone');
      expect(out.platform).toBeNull();
      const expiry = new Date(out.expiresAt).getTime();
      const expected = Date.now() + 14 * 24 * 60 * 60 * 1000;
      // Within 5 seconds of the expected expiry (test execution
      // wiggle).
      expect(Math.abs(expiry - expected)).toBeLessThan(5_000);
    });

    it('NEVER persists a raw channel value (no `value`, no `hash` field)', async () => {
      setupCreateOk();
      await service.create(SENDER_ID, { channel: 'email' });
      const call = prisma.invite.create.mock.calls[0][0];
      // Privacy invariant: the persisted row has only `channel`
      // (coarse type), `platform` (optional), `token`, +
      // bookkeeping. Any field that could leak the raw input
      // would be a regression.
      const persistedKeys = Object.keys(call.data).sort();
      expect(persistedKeys).toEqual(
        [
          'channel',
          'createdByUserId',
          'expiresAt',
          'platform',
          'status',
          'token',
        ].sort(),
      );
    });

    it('builds the public URL with /i/<token>', async () => {
      setupCreateOk();
      const out = await service.create(SENDER_ID, { channel: 'unknown' });
      // URL ends with /i/<token>. The origin is operator-config
      // dependent; we don't assert on it here.
      expect(out.inviteUrl.endsWith(`/i/${out.token}`)).toBe(true);
    });

    it('emits both Arabic + English suggested message templates', async () => {
      setupCreateOk();
      const out = await service.create(SENDER_ID, { channel: 'phone' });
      // Both templates carry the invite URL.
      expect(out.suggestedMessage.ar).toContain(out.inviteUrl);
      expect(out.suggestedMessage.en).toContain(out.inviteUrl);
      // Privacy: templates never carry the sender's id / username
      // / phone / email. They only mention the invite URL.
      expect(out.suggestedMessage.ar).not.toContain(SENDER_ID);
      expect(out.suggestedMessage.en).not.toContain(SENDER_ID);
    });

    describe('channel validation', () => {
      it('accepts phone, email, social, unknown', async () => {
        for (const channel of ['phone', 'email', 'unknown'] as const) {
          setupCreateOk();
          await expect(
            service.create(SENDER_ID, { channel }),
          ).resolves.toBeDefined();
        }
      });

      it('rejects unknown channel values', async () => {
        await expect(
          service.create(SENDER_ID, { channel: 'fax' as never }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('requires platform for social channel', async () => {
        await expect(
          service.create(SENDER_ID, { channel: 'social' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects unsupported social platforms', async () => {
        await expect(
          service.create(SENDER_ID, {
            channel: 'social',
            platform: 'orkut' as never,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('strips platform when channel is not social', async () => {
        setupCreateOk();
        const out = await service.create(SENDER_ID, {
          channel: 'phone',
          platform: 'snapchat',
        });
        expect(out.platform).toBeNull();
      });
    });

    describe('social platform support', () => {
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

      it.each(PLATFORMS)(
        'accepts %s and returns its platformOpenUrl',
        async (platform) => {
          setupCreateOk();
          const out = await service.create(SENDER_ID, {
            channel: 'social',
            platform,
          });
          expect(out.platform).toBe(platform);
          // platformOpenUrl is a known safe URL — never includes
          // a per-recipient handle (which Qift never sees).
          expect(out.platformOpenUrl).toBeTruthy();
          expect(out.platformOpenUrl).not.toContain('@');
        },
      );
    });

    describe('rate-limit', () => {
      it('throws 429 on the 21st invite within 24h', async () => {
        prisma.invite.count.mockResolvedValueOnce(20);
        await expect(
          service.create(SENDER_ID, { channel: 'phone' }),
        ).rejects.toBeInstanceOf(HttpException);
      });

      it('allows the 20th invite (cap is exclusive of the limit)', async () => {
        prisma.invite.count.mockResolvedValueOnce(19);
        prisma.invite.create.mockResolvedValueOnce({
          id: 'inv_at_limit',
          token: 'xxxx',
          channel: 'phone',
          platform: null,
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        await expect(
          service.create(SENDER_ID, { channel: 'phone' }),
        ).resolves.toBeDefined();
      });

      it('passes a 24h window to the rate-limit count query', async () => {
        setupCreateOk();
        await service.create(SENDER_ID, { channel: 'phone' });
        const call = prisma.invite.count.mock.calls[0][0];
        expect(call.where.createdByUserId).toBe(SENDER_ID);
        const gte = call.where.createdAt.gte as Date;
        const expectedThreshold = Date.now() - 24 * 60 * 60 * 1000;
        expect(Math.abs(gte.getTime() - expectedThreshold)).toBeLessThan(5_000);
      });
    });
  });

  describe('listMine', () => {
    it('returns newest-first, with derived expired status for past TTL', async () => {
      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 86_400_000);
      prisma.invite.findMany.mockResolvedValueOnce([
        {
          id: 'inv_expired',
          token: 'tokA',
          channel: 'phone',
          platform: null,
          status: 'active', // still 'active' in DB
          createdAt: new Date(Date.now() - 30 * 86_400_000),
          expiresAt: past,
          consumedAt: null,
        },
        {
          id: 'inv_active',
          token: 'tokB',
          channel: 'email',
          platform: null,
          status: 'active',
          createdAt: new Date(Date.now() - 60_000),
          expiresAt: future,
          consumedAt: null,
        },
      ]);
      const out = await service.listMine(SENDER_ID);
      // The expired row surfaces as 'expired' in the view even
      // though the DB row is still 'active' (lazy transition).
      expect(out[0].status).toBe('expired');
      expect(out[1].status).toBe('active');
    });
  });

  describe('revoke', () => {
    it('refuses to revoke an invite the caller did not create', async () => {
      prisma.invite.findUnique.mockResolvedValueOnce({
        id: 'inv_other',
        createdByUserId: 'user_other',
        status: 'active',
      });
      await expect(
        service.revoke(SENDER_ID, 'inv_other'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 when the invite does not exist', async () => {
      prisma.invite.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.revoke(SENDER_ID, 'inv_missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a no-op on already-non-active invites', async () => {
      prisma.invite.findUnique.mockResolvedValueOnce({
        id: 'inv_consumed',
        createdByUserId: SENDER_ID,
        status: 'consumed',
      });
      const out = await service.revoke(SENDER_ID, 'inv_consumed');
      expect(out.status).toBe('consumed');
      expect(prisma.invite.updateMany).not.toHaveBeenCalled();
    });

    it('flips active → revoked race-safely (updateMany predicate)', async () => {
      prisma.invite.findUnique.mockResolvedValueOnce({
        id: 'inv_active',
        createdByUserId: SENDER_ID,
        status: 'active',
      });
      prisma.invite.updateMany.mockResolvedValueOnce({ count: 1 });
      const out = await service.revoke(SENDER_ID, 'inv_active');
      const call = prisma.invite.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'inv_active', status: 'active' });
      expect(call.data).toEqual({ status: 'revoked' });
      expect(out.status).toBe('revoked');
    });
  });

  describe('resolvePublic — privacy invariants', () => {
    it('returns isValid=false for non-existent tokens (no PII leak)', async () => {
      prisma.invite.findUnique.mockResolvedValueOnce(null);
      const out = await service.resolvePublic('a'.repeat(32));
      expect(out).toEqual({ isValid: false, expiresAt: null });
    });

    it('returns isValid=false for revoked invites without revealing the revocation', async () => {
      prisma.invite.findUnique.mockResolvedValueOnce({
        status: 'revoked',
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const out = await service.resolvePublic('x'.repeat(32));
      expect(out.isValid).toBe(false);
      expect(out.expiresAt).toBeNull();
    });

    it('returns isValid=false for expired invites without revealing the expiry', async () => {
      prisma.invite.findUnique.mockResolvedValueOnce({
        status: 'active',
        expiresAt: new Date(Date.now() - 60_000),
      });
      const out = await service.resolvePublic('y'.repeat(32));
      expect(out.isValid).toBe(false);
      expect(out.expiresAt).toBeNull();
    });

    it('returns isValid=true + expiresAt only for active, unexpired invites', async () => {
      const expiresAt = new Date(Date.now() + 10 * 86_400_000);
      prisma.invite.findUnique.mockResolvedValueOnce({
        status: 'active',
        expiresAt,
      });
      const out = await service.resolvePublic('z'.repeat(32));
      expect(out.isValid).toBe(true);
      expect(out.expiresAt).toBe(expiresAt.toISOString());
    });

    it('rejects malformed tokens without hitting the database', async () => {
      // Too short → return isValid=false immediately; no DB
      // round-trip. Stops a high-volume scan from amplifying
      // enumeration attempts into DB load.
      const out = await service.resolvePublic('short');
      expect(out.isValid).toBe(false);
      expect(prisma.invite.findUnique).not.toHaveBeenCalled();
    });
  });
});
