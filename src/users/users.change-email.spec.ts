// Change-email flow unit tests (PR 6 — mirror of change-phone).
//
// CONTRACT THIS SPEC PINS
//   start:
//     - malformed email   → 400 invalid_email, nothing dispatched
//     - same as current   → 400 email_unchanged (case-insensitive)
//     - email on another  → 409 envelope { code: 'email_taken' }
//       account             before any send
//     - otherwise         → OtpService.send with the LOWERCASED
//                           target, type 'email'
//   confirm:
//     - verify failure propagates, row untouched, no audit
//     - success → email = lowercased target, emailVerifiedAt freshly
//       stamped, audit 'user.email.change' { from, to }
//     - P2002 race → 409 email_taken, NO audit row
//     - works as "add email with proof" when current email is null

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from '../blocks/blocks.service';
import { OtpService } from '../otp/otp.service';
import { AuditService } from '../audit/audit.service';

const USER_ID = 'usr_1';
const OLD_EMAIL = 'old@example.com';
const NEW_EMAIL = 'new@example.com';

describe('UsersService — change email (OTP-verified)', () => {
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
        findUnique: jest.fn().mockResolvedValue({ email: OLD_EMAIL }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    otp = {
      send: jest.fn().mockResolvedValue({
        ok: true,
        dispatched: true,
        channel: 'email',
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

    jest
      .spyOn(service, 'getProfile')
      .mockResolvedValue({ id: USER_ID } as never);
  });

  describe('changeEmailStart', () => {
    it('rejects a malformed address without dispatching', async () => {
      await expect(
        service.changeEmailStart(USER_ID, 'not-an-email'),
      ).rejects.toThrow('invalid_email');
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('rejects the current email case-insensitively (email_unchanged)', async () => {
      await expect(
        service.changeEmailStart(USER_ID, 'OLD@Example.com'),
      ).rejects.toThrow('email_unchanged');
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('409 email_taken when another account holds the address', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'usr_other' });

      let thrown: unknown;
      try {
        await service.changeEmailStart(USER_ID, NEW_EMAIL);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(409);
      expect(
        ((thrown as HttpException).getResponse() as { code?: string }).code,
      ).toBe('email_taken');
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('dispatches to the LOWERCASED target on success', async () => {
      const result = await service.changeEmailStart(USER_ID, ' NEW@Example.com ');
      expect(otp.send).toHaveBeenCalledWith({
        target: NEW_EMAIL,
        type: 'email',
      });
      expect(result).toMatchObject({ ok: true, channel: 'email' });
    });
  });

  describe('changeEmailConfirm', () => {
    it('missing code → invalid_code before any OTP work', async () => {
      await expect(
        service.changeEmailConfirm(USER_ID, NEW_EMAIL, ''),
      ).rejects.toThrow('invalid_code');
      expect(otp.verify).not.toHaveBeenCalled();
    });

    it('verify failure propagates and the row is untouched', async () => {
      otp.verify.mockRejectedValue(new BadRequestException('expired_code'));

      await expect(
        service.changeEmailConfirm(USER_ID, NEW_EMAIL, '123456'),
      ).rejects.toThrow('expired_code');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('success: stamps emailVerifiedAt and audits old → new', async () => {
      await service.changeEmailConfirm(USER_ID, ' NEW@Example.com ', '123456');

      expect(otp.verify).toHaveBeenCalledWith({
        target: NEW_EMAIL,
        code: '123456',
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: {
          email: NEW_EMAIL,
          emailVerifiedAt: expect.any(Date) as Date,
        },
      });
      expect(audit.record).toHaveBeenCalledWith({
        actorUserId: USER_ID,
        actorType: 'user',
        action: 'user.email.change',
        targetType: 'user',
        targetId: USER_ID,
        metadata: { from: OLD_EMAIL, to: NEW_EMAIL },
      });
    });

    it('adding a first email (current null) works — null !== target', async () => {
      prisma.user.findUnique.mockResolvedValue({ email: null });

      await service.changeEmailConfirm(USER_ID, NEW_EMAIL, '123456');

      expect(prisma.user.update).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { from: null, to: NEW_EMAIL } }),
      );
    });

    it('P2002 race on update → 409 email_taken, NO audit row', async () => {
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      let thrown: unknown;
      try {
        await service.changeEmailConfirm(USER_ID, NEW_EMAIL, '123456');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(409);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('pre-verify uniqueness check refuses before burning the code', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'usr_other' });

      await expect(
        service.changeEmailConfirm(USER_ID, NEW_EMAIL, '123456'),
      ).rejects.toBeInstanceOf(HttpException);
      expect(otp.verify).not.toHaveBeenCalled();
    });
  });
});
