// OtpService.verify unit tests — Week 1 security hardening (F1).
//
// CONTRACT THIS SPEC PINS
// `verify()` MUST:
//   1. Reject with `otp_locked` when the matched row has already
//      reached MAX_VERIFY_ATTEMPTS (=5), BEFORE comparing the code.
//      This is the brute-force defence: a row with 5 wrong attempts
//      is dead, even if the 6th submission is the correct code.
//   2. Increment `attempts` on every wrong-code submission via an
//      atomic Prisma update so concurrent attempts each cost one.
//   3. NOT increment on expired rows (expiry is a distinct dead-row
//      state from lockout).
//   4. NOT increment on absent rows (no row to update).
//   5. Preserve the existing success path: matching valid code
//      deletes the row and returns { ok: true }.
//   6. Preserve all existing exception messages: `invalid_code`,
//      `expired_code`, and `target and code are required`. The new
//      message `otp_locked` is the only addition.
//
// The /otp/send rate limiter (5 sends per target per 5 minutes) is
// out of scope for this spec — F1 is purely the verify-side fix.

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { RiskSignalService } from '../risk-signals/risk-signal.service';

type MockPrisma = {
  otp: {
    findFirst: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
};

const TARGET_PHONE = '+966500001000';

function makeOtpRow(
  overrides: Partial<{
    id: string;
    code: string;
    attempts: number;
    expiresAt: Date;
  }> = {},
): {
  id: string;
  target: string;
  code: string;
  type: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
} {
  return {
    id: 'otp-1',
    target: TARGET_PHONE,
    code: '1234',
    type: 'phone',
    // Default to 4 minutes in the future — comfortably inside the
    // 5-minute TTL the service applies on send.
    expiresAt: new Date(Date.now() + 4 * 60 * 1000),
    attempts: 0,
    consumedAt: null,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('OtpService — verify (F1: per-row attempt cap + lockout)', () => {
  let service: OtpService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = {
      otp: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        // MailService + RiskSignalService aren't consulted by
        // verify(); stub-and-forget.
        { provide: MailService, useValue: {} },
        { provide: RiskSignalService, useValue: { record: jest.fn() } },
      ],
    }).compile();
    service = module.get<OtpService>(OtpService);
  });

  // ───────────────────────────────────────────────────────────────────
  describe('happy path', () => {
    it('matching code + non-expired + attempts < cap → returns { ok: true }', async () => {
      prisma.otp.findFirst.mockResolvedValue(makeOtpRow({ code: '1234' }));

      const result = await service.verify({
        target: TARGET_PHONE,
        code: '1234',
      });

      expect(result).toEqual({ ok: true });
    });

    it('success path deletes the OTP row (single-use)', async () => {
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({ id: 'otp-success', code: '4321' }),
      );

      await service.verify({ target: TARGET_PHONE, code: '4321' });

      expect(prisma.otp.delete).toHaveBeenCalledWith({
        where: { id: 'otp-success' },
      });
    });

    it('success path does NOT increment attempts', async () => {
      prisma.otp.findFirst.mockResolvedValue(makeOtpRow({ code: '1234' }));

      await service.verify({ target: TARGET_PHONE, code: '1234' });

      expect(prisma.otp.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('wrong code increments attempts', () => {
    it('wrong code with attempts=0 → throws invalid_code AND increments attempts atomically', async () => {
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({ id: 'otp-bad-1', code: '1234', attempts: 0 }),
      );

      await expect(
        service.verify({ target: TARGET_PHONE, code: '9999' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.verify({ target: TARGET_PHONE, code: '9999' }),
      ).rejects.toThrow('invalid_code');

      // Both .rejects assertions call verify, so the update is
      // invoked twice. The {increment: 1} payload is what matters.
      expect(prisma.otp.update).toHaveBeenCalledWith({
        where: { id: 'otp-bad-1' },
        data: { attempts: { increment: 1 } },
      });
    });

    it('wrong code with attempts=4 → still invalid_code (NOT yet locked)', async () => {
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({ code: '1234', attempts: 4 }),
      );

      await expect(
        service.verify({ target: TARGET_PHONE, code: '9999' }),
      ).rejects.toThrow('invalid_code');

      expect(prisma.otp.update).toHaveBeenCalled();
    });

    it('attempt-increment Prisma failure does NOT change the user-facing error', async () => {
      // Defence-in-depth: a transient DB hiccup must not let the
      // user see a different error code than the attack-defensive
      // 'invalid_code'.
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({ code: '1234', attempts: 1 }),
      );
      prisma.otp.update.mockRejectedValueOnce(new Error('transient'));

      await expect(
        service.verify({ target: TARGET_PHONE, code: '9999' }),
      ).rejects.toThrow('invalid_code');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('lockout: attempts >= MAX_VERIFY_ATTEMPTS', () => {
    it('attempts=5 → throws otp_locked WITHOUT comparing code or incrementing', async () => {
      // Lockout fires before code comparison: even submitting the
      // CORRECT code (1234) on a row that has reached the cap must
      // return locked, not success.
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({ code: '1234', attempts: 5 }),
      );

      await expect(
        service.verify({ target: TARGET_PHONE, code: '1234' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.verify({ target: TARGET_PHONE, code: '1234' }),
      ).rejects.toThrow('otp_locked');

      // No update (would be a meaningless +1 on a dead row), no
      // delete (success path didn't run).
      expect(prisma.otp.update).not.toHaveBeenCalled();
      expect(prisma.otp.delete).not.toHaveBeenCalled();
    });

    it('attempts=6 (overshoot edge case) → still otp_locked', async () => {
      // Belt-and-braces: the comparison is `>=`, so any value at or
      // above MAX_VERIFY_ATTEMPTS locks. Some replication topologies
      // could in theory produce attempts > 5 if two writers raced.
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({ code: '1234', attempts: 6 }),
      );

      await expect(
        service.verify({ target: TARGET_PHONE, code: '1234' }),
      ).rejects.toThrow('otp_locked');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('expired row', () => {
    it('expired + correct code → throws expired_code (NOT incremented)', async () => {
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({
          code: '1234',
          attempts: 1,
          expiresAt: new Date(Date.now() - 60 * 1000),
        }),
      );

      await expect(
        service.verify({ target: TARGET_PHONE, code: '1234' }),
      ).rejects.toThrow('expired_code');

      expect(prisma.otp.update).not.toHaveBeenCalled();
    });

    it('expired + wrong code → still expired_code (expiry runs before code compare)', async () => {
      prisma.otp.findFirst.mockResolvedValue(
        makeOtpRow({
          code: '1234',
          attempts: 0,
          expiresAt: new Date(Date.now() - 60 * 1000),
        }),
      );

      await expect(
        service.verify({ target: TARGET_PHONE, code: '9999' }),
      ).rejects.toThrow('expired_code');

      expect(prisma.otp.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('absent row', () => {
    it('no row for target → throws invalid_code (NO update attempted)', async () => {
      prisma.otp.findFirst.mockResolvedValue(null);

      await expect(
        service.verify({ target: TARGET_PHONE, code: '1234' }),
      ).rejects.toThrow('invalid_code');

      expect(prisma.otp.update).not.toHaveBeenCalled();
      expect(prisma.otp.delete).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('input validation (regression)', () => {
    it('missing target → throws "target and code are required" WITHOUT DB hit', async () => {
      await expect(service.verify({ code: '1234' })).rejects.toThrow(
        'target and code are required',
      );
      expect(prisma.otp.findFirst).not.toHaveBeenCalled();
    });

    it('missing code → throws "target and code are required" WITHOUT DB hit', async () => {
      await expect(service.verify({ target: TARGET_PHONE })).rejects.toThrow(
        'target and code are required',
      );
      expect(prisma.otp.findFirst).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('full sequence: 5 wrong attempts then 6th is locked', () => {
    it('attempts increment monotonically until cap, then lock', async () => {
      // Simulate the realistic brute-force pattern: same row, 5
      // wrong guesses, 6th guess (even if correct) hits the cap.
      // Each call sees a row with the previous call's incremented
      // attempts value.
      const id = 'otp-bruteforce';

      for (let n = 0; n < 5; n++) {
        prisma.otp.findFirst.mockResolvedValueOnce(
          makeOtpRow({ id, code: '1234', attempts: n }),
        );
        await expect(
          service.verify({ target: TARGET_PHONE, code: '0000' }),
        ).rejects.toThrow('invalid_code');
      }

      // 6th submission: the row now has attempts=5 (cap reached).
      // Even a CORRECT code is rejected.
      prisma.otp.findFirst.mockResolvedValueOnce(
        makeOtpRow({ id, code: '1234', attempts: 5 }),
      );
      await expect(
        service.verify({ target: TARGET_PHONE, code: '1234' }),
      ).rejects.toThrow('otp_locked');

      // 5 increments fired (one per wrong attempt); 0 on the locked
      // attempt; 0 deletes (success never ran).
      expect(prisma.otp.update).toHaveBeenCalledTimes(5);
      expect(prisma.otp.delete).not.toHaveBeenCalled();
    });
  });
});
