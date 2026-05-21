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

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest mocks are intentionally `any`-typed inside test files. */

import { Test, type TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { MailService } from '../mail/mail.service';
import { InvitesService } from '../invites/invites.service';
import { NotificationsService } from '../notifications/notifications.service';

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
