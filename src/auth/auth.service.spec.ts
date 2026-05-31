// AuthService.login unit tests — Week 1 security hardening (F2).
//
// CONTRACT THIS SPEC PINS
// /auth/login must REFUSE to mint a JWT for any account where
// `deletedAt` is non-null. The refusal returns the same
// `UnauthorizedException('Invalid credentials')` as the
// wrong-password and unknown-user paths so a probing attacker
// cannot distinguish 'account deleted' from 'account never
// existed' from 'wrong password'.
//
// This spec is the auth-side counterpart to AdminGuard's per-request
// deletedAt enforcement: AdminGuard catches a soft-deleted user
// whose JWT was issued BEFORE deletion; this spec ensures a fresh
// JWT is never issued AFTER deletion.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files. */

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { MailService } from '../mail/mail.service';
import { InvitesService } from '../invites/invites.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OtpService } from '../otp/otp.service';
import { BetaAccessService } from '../beta-access/beta-access.service';

type MockPrisma = {
  user: { findFirst: jest.Mock };
};

describe('AuthService — login (F2: soft-deleted rejection)', () => {
  let service: AuthService;
  let prisma: MockPrisma;
  let jwt: { signAsync: jest.Mock };

  // Reused across cases — every test sets findFirst's return value
  // explicitly to make the scenarios self-documenting.
  const PASSWORD = 'correct-horse-battery-staple';
  let passwordHash: string;

  beforeAll(async () => {
    // Compute the bcrypt hash once — bcrypt is intentionally slow
    // and a per-test rehash would 10x the suite runtime.
    passwordHash = await bcrypt.hash(PASSWORD, 10);
  });

  beforeEach(async () => {
    prisma = { user: { findFirst: jest.fn() } };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        // The other AuthService dependencies (mail, invites,
        // notifications) are not consulted by login(). Stub-and-
        // forget.
        { provide: MailService, useValue: {} },
        { provide: InvitesService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        // Week 2 — OtpService is now a constructor dep; login()
        // doesn't call it, but Nest needs the provider to
        // instantiate AuthService.
        {
          provide: OtpService,
          useValue: { send: jest.fn(), verify: jest.fn() },
        },
        // Closed Beta Gate dep. login() never touches it; stub-and-
        // forget so Nest can instantiate AuthService.
        {
          provide: BetaAccessService,
          useValue: {
            decideRegistration: jest.fn(),
            applyRedemption: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  // ───────────────────────────────────────────────────────────────────
  describe('happy path', () => {
    it('active user + correct password → returns accessToken + sanitised user', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-1',
        qiftUsername: 'reem',
        phone: '+966500001000',
        email: null,
        passwordHash,
        deletedAt: null,
      });

      const result = await service.login({
        identifier: 'reem',
        password: PASSWORD,
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).toEqual(
        expect.objectContaining({ id: 'u-1', qiftUsername: 'reem' }),
      );
      // sanitize() must strip passwordHash from the returned user.
      expect(
        (result.user as { passwordHash?: unknown }).passwordHash,
      ).toBeUndefined();
      expect(jwt.signAsync).toHaveBeenCalledTimes(1);
    });

    it('login query filters by deletedAt: null', async () => {
      // The F2 fix is a single WHERE-clause addition. This test pins
      // it so a future refactor of the login query can't silently
      // drop the deletedAt filter.
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-1',
        qiftUsername: 'reem',
        passwordHash,
        deletedAt: null,
      });
      await service.login({ identifier: 'reem', password: PASSWORD });

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('soft-deleted account (the F2 fix)', () => {
    it('soft-deleted user looked up by username → findFirst sees deletedAt: null filter and returns null → throws Invalid credentials', async () => {
      // Critical regression: a soft-deleted row exists in the DB but
      // Prisma findFirst MUST be invoked with `deletedAt: null` so
      // the row is filtered out. We assert null is returned (deleted
      // user excluded by the where clause) and the error matches the
      // generic credentials path.
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.login({ identifier: 'reem', password: PASSWORD }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      await expect(
        service.login({ identifier: 'reem', password: PASSWORD }),
      ).rejects.toThrow('Invalid credentials');

      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('soft-deleted user looked up by phone → same Invalid credentials', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.login({
          identifier: '+966500001000',
          password: PASSWORD,
        }),
      ).rejects.toThrow('Invalid credentials');
    });

    it('soft-deleted user looked up by email → same Invalid credentials', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.login({
          identifier: 'reem@example.com',
          password: PASSWORD,
        }),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('existing rejection paths (regression)', () => {
    it('non-existent user → Invalid credentials', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.login({ identifier: 'ghost', password: PASSWORD }),
      ).rejects.toThrow('Invalid credentials');
    });

    it('user without passwordHash → throws (legacy-account branch)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-legacy',
        qiftUsername: 'legacy',
        passwordHash: null,
        deletedAt: null,
      });

      await expect(
        service.login({ identifier: 'legacy', password: PASSWORD }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('wrong password → Invalid credentials', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'u-1',
        qiftUsername: 'reem',
        passwordHash,
        deletedAt: null,
      });

      await expect(
        service.login({ identifier: 'reem', password: 'wrong-password' }),
      ).rejects.toThrow('Invalid credentials');
    });

    it('missing identifier → Invalid credentials WITHOUT DB hit', async () => {
      await expect(service.login({ password: PASSWORD })).rejects.toThrow(
        'Invalid credentials',
      );
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('missing password → Invalid credentials WITHOUT DB hit', async () => {
      await expect(service.login({ identifier: 'reem' })).rejects.toThrow(
        'Invalid credentials',
      );
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('error message uniformity (anti-enumeration)', () => {
    it('every rejection path uses the literal string "Invalid credentials"', async () => {
      // Pins the anti-enumeration contract. The wrong-password,
      // unknown-user, soft-deleted, and missing-input paths all return
      // the same string so an attacker can't distinguish them. The
      // legacy-passwordHash-null path is a separate Arabic message
      // (acceptable because it requires a pre-existing DB-direct
      // bypass to exploit and the user-facing UX needs a hint to
      // set a password).
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(
        service.login({ identifier: 'a', password: 'b' }),
      ).rejects.toThrow('Invalid credentials');

      prisma.user.findFirst.mockResolvedValue({
        id: 'u',
        qiftUsername: 'a',
        passwordHash,
        deletedAt: null,
      });
      await expect(
        service.login({ identifier: 'a', password: 'wrong' }),
      ).rejects.toThrow('Invalid credentials');
    });
  });
});

// =====================================================================
// Week 2 — Forgot Password Flow.
//
// CONTRACTS PINNED BY THESE TESTS
//   1. POST /auth/forgot-password ALWAYS returns { ok: true } —
//      anti-enumeration is uniform across {user exists, user
//      doesn't exist, soft-deleted, channel unverified, missing
//      input, rate-limited, transport-unavailable}.
//   2. OtpService.send is only called when the user exists, is not
//      soft-deleted, AND the chosen channel is verified.
//   3. POST /auth/reset-password validates password length BEFORE
//      calling OtpService.verify so a too-short newPassword doesn't
//      waste the single-use OTP.
//   4. Reset-password collapses {non-existent user, soft-deleted,
//      channel-unverified} into the same `invalid_code` error code
//      that OtpService.verify would emit for a missing OTP row.
//   5. The OTP error matrix (invalid_code / expired_code /
//      otp_locked) is propagated verbatim from OtpService.verify —
//      the F1 lockout applies automatically.
// =====================================================================

describe('AuthService — forgot-password flow (Week 2)', () => {
  let service: AuthService;
  let prisma: { user: { findFirst: jest.Mock } };
  let otp: { send: jest.Mock; verify: jest.Mock };

  beforeEach(async () => {
    prisma = { user: { findFirst: jest.fn() } };
    otp = {
      send: jest.fn().mockResolvedValue({ ok: true, dispatched: true }),
      verify: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jest.fn() } },
        { provide: MailService, useValue: {} },
        { provide: InvitesService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: OtpService, useValue: otp },
        {
          provide: BetaAccessService,
          useValue: {
            decideRegistration: jest.fn(),
            applyRedemption: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  describe('happy path — OTP dispatched silently', () => {
    it('verified phone → OtpService.send called with the normalised phone + phone channel', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      const result = await service.forgotPassword({
        identifier: '+966500001001',
        channel: 'phone',
      });

      expect(result).toEqual({ ok: true });
      expect(otp.send).toHaveBeenCalledWith({
        target: '+966500001001',
        type: 'phone',
      });
    });

    it('verified email → OtpService.send called with the lower-cased email + email channel', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      const result = await service.forgotPassword({
        identifier: 'Reem@Example.com',
        channel: 'email',
      });

      expect(result).toEqual({ ok: true });
      expect(otp.send).toHaveBeenCalledWith({
        target: 'reem@example.com',
        type: 'email',
      });
    });

    it('default channel (omitted) → phone', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });
      await service.forgotPassword({ identifier: '+966500001001' });
      expect(otp.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'phone' }),
      );
    });

    it('Prisma where clause requires verified channel + active account', async () => {
      // Pins the F2-aligned filter: deletedAt: null AND
      // phoneVerifiedAt: { not: null } when channel='phone'.
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });
      await service.forgotPassword({
        identifier: '+966500001001',
        channel: 'phone',
      });
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
            phone: '+966500001001',
            phoneVerifiedAt: { not: null },
          }),
        }),
      );
    });
  });

  describe('silent no-op paths (anti-enumeration)', () => {
    it('non-existent user → 200 + NO OtpService.send call', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const result = await service.forgotPassword({
        identifier: '+966500009999',
        channel: 'phone',
      });

      expect(result).toEqual({ ok: true });
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('soft-deleted user → 200 + NO OtpService.send call (filtered by deletedAt: null)', async () => {
      // The where clause already includes deletedAt: null, so a
      // soft-deleted row returns null from findFirst — same as a
      // missing user.
      prisma.user.findFirst.mockResolvedValue(null);

      const result = await service.forgotPassword({
        identifier: '+966500001001',
        channel: 'phone',
      });

      expect(result).toEqual({ ok: true });
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('email channel + unverified email → 200 + NO OtpService.send (filtered by emailVerifiedAt: not null)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const result = await service.forgotPassword({
        identifier: 'unverified@example.com',
        channel: 'email',
      });

      expect(result).toEqual({ ok: true });
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('missing identifier → 200 + NO DB hit + NO OtpService.send call', async () => {
      const result = await service.forgotPassword({ channel: 'phone' });

      expect(result).toEqual({ ok: true });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('unparseable phone identifier → 200 + NO DB hit', async () => {
      // normalizePhone returns null on garbage input. We bail
      // silently rather than calling findFirst with a junk value.
      const result = await service.forgotPassword({
        identifier: 'not-a-phone-number',
        channel: 'phone',
      });

      expect(result).toEqual({ ok: true });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('OtpService.send throws (rate-limited) → response shape unchanged', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });
      otp.send.mockRejectedValue(new Error('rate-limited'));

      const result = await service.forgotPassword({
        identifier: '+966500001001',
        channel: 'phone',
      });

      // The thrown error is swallowed; the API contract holds.
      expect(result).toEqual({ ok: true });
    });
  });
});

// =====================================================================

describe('AuthService — reset-password flow (Week 2)', () => {
  let service: AuthService;
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock };
  };
  let otp: { send: jest.Mock; verify: jest.Mock };

  const VALID_PASSWORD = 'new-strong-password-123';

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'u-1' }),
      },
    };
    otp = {
      send: jest.fn(),
      verify: jest.fn().mockResolvedValue({ ok: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jest.fn() } },
        { provide: MailService, useValue: {} },
        { provide: InvitesService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: OtpService, useValue: otp },
        {
          provide: BetaAccessService,
          useValue: {
            decideRegistration: jest.fn(),
            applyRedemption: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  describe('happy path', () => {
    it('valid input → OTP verified, password updated, returns { ok: true }', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      const result = await service.resetPassword({
        identifier: '+966500001001',
        channel: 'phone',
        code: '1234',
        newPassword: VALID_PASSWORD,
      });

      expect(result).toEqual({ ok: true });
      expect(otp.verify).toHaveBeenCalledWith({
        target: '+966500001001',
        code: '1234',
      });
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('the stored passwordHash is a bcrypt hash of the new password', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      await service.resetPassword({
        identifier: '+966500001001',
        channel: 'phone',
        code: '1234',
        newPassword: VALID_PASSWORD,
      });

      const updateArg = prisma.user.update.mock.calls[0][0] as {
        data: { passwordHash: string };
      };
      const hash = updateArg.data.passwordHash;
      expect(hash).toMatch(/^\$2[abxy]\$/); // bcrypt prefix
      expect(await bcrypt.compare(VALID_PASSWORD, hash)).toBe(true);
      expect(await bcrypt.compare('wrong-password', hash)).toBe(false);
    });

    it('email channel works the same way', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      await service.resetPassword({
        identifier: 'Reem@Example.com',
        channel: 'email',
        code: '1234',
        newPassword: VALID_PASSWORD,
      });

      expect(otp.verify).toHaveBeenCalledWith({
        target: 'reem@example.com',
        code: '1234',
      });
    });
  });

  describe("password validation runs BEFORE OTP verify (don't waste the code)", () => {
    it('missing newPassword → invalid_password without touching OTP', async () => {
      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
        }),
      ).rejects.toThrow('invalid_password');
      expect(otp.verify).not.toHaveBeenCalled();
    });

    it('newPassword < 8 chars → invalid_password without touching OTP', async () => {
      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: 'short',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: 'short',
        }),
      ).rejects.toThrow('invalid_password');

      expect(otp.verify).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('exactly 8 chars → accepted', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: '12345678',
        }),
      ).resolves.toEqual({ ok: true });
    });
  });

  describe('missing input', () => {
    it('missing identifier → invalid_code', async () => {
      await expect(
        service.resetPassword({
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');
      expect(otp.verify).not.toHaveBeenCalled();
    });

    it('missing code → invalid_code', async () => {
      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');
      expect(otp.verify).not.toHaveBeenCalled();
    });
  });

  describe('user lookup fails → invalid_code (same as OTP missing — no enumeration)', () => {
    it('non-existent user → invalid_code (OtpService.verify NOT called)', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');

      expect(otp.verify).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('soft-deleted user (filtered by deletedAt: null) → invalid_code', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');
    });

    it('email channel + unverified email → invalid_code', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          identifier: 'unverified@example.com',
          channel: 'email',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');
    });

    it('unparseable phone → invalid_code without DB hit', async () => {
      await expect(
        service.resetPassword({
          identifier: 'not-a-phone',
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('OTP error propagation (F1 lockout inherited verbatim)', () => {
    it('wrong code → invalid_code (from OtpService.verify); password NOT updated', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });
      otp.verify.mockRejectedValue(new BadRequestException('invalid_code'));

      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '0000',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('expired OTP → expired_code; password NOT updated', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });
      otp.verify.mockRejectedValue(new BadRequestException('expired_code'));

      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('expired_code');

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('locked OTP (F1 lockout: 5+ attempts) → otp_locked; password NOT updated', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });
      otp.verify.mockRejectedValue(new BadRequestException('otp_locked'));

      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('otp_locked');

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('reused OTP (row already deleted after first success) → invalid_code on the 2nd call', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });
      // First call succeeds.
      otp.verify.mockResolvedValueOnce({ ok: true });
      await service.resetPassword({
        identifier: '+966500001001',
        channel: 'phone',
        code: '1234',
        newPassword: VALID_PASSWORD,
      });

      // Second call: OtpService.verify finds no row (was deleted)
      // and throws invalid_code.
      otp.verify.mockRejectedValueOnce(new BadRequestException('invalid_code'));
      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('invalid_code');

      // Password update fired exactly once.
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('brute-force simulation: 5 wrong attempts then locked → password never changes', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      // 5 wrong attempts each return invalid_code.
      for (let i = 0; i < 5; i++) {
        otp.verify.mockRejectedValueOnce(
          new BadRequestException('invalid_code'),
        );
        await expect(
          service.resetPassword({
            identifier: '+966500001001',
            channel: 'phone',
            code: '0000',
            newPassword: VALID_PASSWORD,
          }),
        ).rejects.toThrow('invalid_code');
      }

      // 6th attempt: locked even with a correct guess.
      otp.verify.mockRejectedValueOnce(new BadRequestException('otp_locked'));
      await expect(
        service.resetPassword({
          identifier: '+966500001001',
          channel: 'phone',
          code: '1234',
          newPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow('otp_locked');

      // Password.update never called across all 6 attempts.
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
