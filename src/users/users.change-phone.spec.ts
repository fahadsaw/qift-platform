// Change-phone flow unit tests (PR 5 — platform stabilization).
//
// CONTRACT THIS SPEC PINS
//   start:
//     - unparseable phone → 400 invalid_phone, nothing dispatched
//     - same as current   → 400 phone_unchanged, nothing dispatched
//     - phone on another  → 409 envelope { code: 'phone_taken' },
//       account             nothing dispatched (no SMS burned)
//     - otherwise         → delegates to OtpService.send with the
//                           NORMALISED target, type 'phone'
//   confirm:
//     - verify failure (invalid_code / otp_locked / …) propagates and
//       the user row is NOT updated
//     - success → user.phone = normalised target, phoneVerifiedAt
//       freshly stamped, audit row 'user.phone.change' with
//       { from, to }, returns the profile envelope
//     - P2002 race on the update → 409 phone_taken, NO audit row
//
// Normalisation: callers may submit local format ("0501234567");
// both steps must key OTP + DB work off the canonical E.164.

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from '../blocks/blocks.service';
import { OtpService } from '../otp/otp.service';
import { AuditService } from '../audit/audit.service';

const USER_ID = 'usr_1';
const OLD_PHONE = '+966500000001';
const NEW_PHONE = '+966500000002';

describe('UsersService — change phone (OTP-verified)', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };
  let otp: { send: jest.Mock; verify: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ phone: OLD_PHONE }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    otp = {
      send: jest.fn().mockResolvedValue({
        ok: true,
        dispatched: true,
        channel: 'phone',
        expiresAt: new Date(),
      }),
      verify: jest.fn().mockResolvedValue({ ok: true }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: BlocksService, useValue: {} },
        { provide: OtpService, useValue: otp },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get<UsersService>(UsersService);

    // confirm() ends by returning the /users/me envelope; that path
    // runs several unrelated queries. Stub it — this suite pins the
    // change semantics, not the profile projection.
    jest
      .spyOn(service, 'getProfile')
      .mockResolvedValue({ id: USER_ID } as never);
  });

  describe('changePhoneStart', () => {
    it('rejects an unparseable phone without dispatching', async () => {
      await expect(
        service.changePhoneStart(USER_ID, 'not-a-phone'),
      ).rejects.toThrow('invalid_phone');
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('rejects the current phone (phone_unchanged) without dispatching', async () => {
      await expect(
        service.changePhoneStart(USER_ID, OLD_PHONE),
      ).rejects.toThrow('phone_unchanged');
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('409 phone_taken when another account holds the number — no SMS burned', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'usr_other' });

      let thrown: unknown;
      try {
        await service.changePhoneStart(USER_ID, NEW_PHONE);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      const http = thrown as HttpException;
      expect(http.getStatus()).toBe(409);
      expect((http.getResponse() as { code?: string }).code).toBe(
        'phone_taken',
      );
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('dispatches the OTP to the NORMALISED target on success', async () => {
      // Local Saudi format in, E.164 out.
      const result = await service.changePhoneStart(USER_ID, '0500000002');
      expect(otp.send).toHaveBeenCalledWith({
        target: NEW_PHONE,
        type: 'phone',
      });
      expect(result).toMatchObject({ ok: true, channel: 'phone' });
    });
  });

  describe('changePhoneConfirm', () => {
    it('missing code → invalid_code before any OTP work', async () => {
      await expect(
        service.changePhoneConfirm(USER_ID, NEW_PHONE, '  '),
      ).rejects.toThrow('invalid_code');
      expect(otp.verify).not.toHaveBeenCalled();
    });

    it('verify failure propagates and the row is untouched', async () => {
      otp.verify.mockRejectedValue(new BadRequestException('otp_locked'));

      await expect(
        service.changePhoneConfirm(USER_ID, NEW_PHONE, '123456'),
      ).rejects.toThrow('otp_locked');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('success: verifies against the new number, stamps phoneVerifiedAt, audits old → new', async () => {
      await service.changePhoneConfirm(USER_ID, '0500000002', '123456');

      expect(otp.verify).toHaveBeenCalledWith({
        target: NEW_PHONE,
        code: '123456',
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          phone: NEW_PHONE,
          phoneVerifiedAt: expect.any(Date) as Date,
        },
      });
      expect(audit.record).toHaveBeenCalledWith({
        actorUserId: USER_ID,
        actorType: 'user',
        action: 'user.phone.change',
        targetType: 'user',
        targetId: USER_ID,
        metadata: { from: OLD_PHONE, to: NEW_PHONE },
      });
    });

    it('P2002 race on update → 409 phone_taken, NO audit row', async () => {
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      let thrown: unknown;
      try {
        await service.changePhoneConfirm(USER_ID, NEW_PHONE, '123456');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(409);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('pre-verify uniqueness check refuses before burning the single-use code', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'usr_other' });

      await expect(
        service.changePhoneConfirm(USER_ID, NEW_PHONE, '123456'),
      ).rejects.toBeInstanceOf(HttpException);
      expect(otp.verify).not.toHaveBeenCalled();
    });
  });
});
