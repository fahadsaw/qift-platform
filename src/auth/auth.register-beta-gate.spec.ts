// AuthService.register × Closed Beta Gate — orchestration tests.
//
// These complement beta-access.service.spec.ts (which tests the gate
// DECISION in isolation). Here the gate is a mock; what we assert is
// that register() wires it correctly:
//
//   1. existing-user LOGIN never consults the gate (returning users are
//      ungated regardless of BETA_GATE_ENABLED).
//   2. a gate denial aborts registration BEFORE any user row is created.
//   3. a gate approval creates the user AND redeems the code inside the
//      SAME transaction (applyRedemption receives the tx + new user id).
//
// PrismaService + JwtService + the gate are hand-mocked; $transaction is
// stubbed to invoke its callback with a tx whose user.create we can
// observe.

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { MailService } from '../mail/mail.service';
import { OtpService } from '../otp/otp.service';
import { BetaAccessService } from '../beta-access/beta-access.service';

describe('AuthService.register — Closed Beta Gate orchestration', () => {
  let service: AuthService;

  // Shared mocks, reset per test.
  const txUserCreate = jest.fn();
  let prisma: {
    otp: { findFirst: jest.Mock; delete: jest.Mock };
    user: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let beta: {
    decideRegistration: jest.Mock;
    applyRedemption: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock };
  let otpVerify: jest.Mock;

  const validOtp = {
    id: 'otp-1',
    code: '123456',
    type: 'phone',
    expiresAt: new Date(Date.now() + 60_000),
  };

  beforeEach(async () => {
    txUserCreate.mockReset();
    prisma = {
      otp: {
        findFirst: jest.fn().mockResolvedValue(validOtp),
        delete: jest.fn().mockResolvedValue({}),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ user: { create: txUserCreate } }),
      ),
    };
    beta = {
      decideRegistration: jest.fn(),
      applyRedemption: jest.fn().mockResolvedValue(undefined),
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-jwt') };
    otpVerify = jest.fn().mockResolvedValue({ ok: true, otpId: 'otp-1' });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: MailService, useValue: {} },
        {
          provide: OtpService,
          // Track A4 — register now verifies through OtpService (lockout
          // path); consume:false returns the row id for later deletion.
          useValue: { send: jest.fn(), verify: otpVerify },
        },
        { provide: BetaAccessService, useValue: beta },
      ],
    }).compile();
    service = moduleRef.get<AuthService>(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  it('Track A4: OTP lockout now binds register — otp_locked propagates, nothing created', async () => {
    otpVerify.mockRejectedValueOnce(new BadRequestException('otp_locked'));
    await expect(
      service.register({
        phone: '0509999999',
        code: '123456',
        qiftUsername: 'newbie',
        password: 'password123',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'otp_locked' }),
    });
    expect(txUserCreate).not.toHaveBeenCalled();
    expect(prisma.otp.delete).not.toHaveBeenCalled();
  });

  it('Track A4: register verifies through OtpService with consume:false + the proven channel, then burns the row itself', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    beta.decideRegistration.mockResolvedValue({ mode: 'open' });
    txUserCreate.mockResolvedValue({
      id: 'u-new',
      qiftUsername: 'newbie',
      passwordHash: 'h',
    });
    await service.register({
      phone: '0509999999',
      code: '123456',
      qiftUsername: 'newbie',
      password: 'password123',
    });
    expect(otpVerify).toHaveBeenCalledWith(
      expect.objectContaining({ consume: false, type: 'phone' }),
    );
    // The single-use row is burned by register AFTER success, by the
    // id verify returned — not by verify itself.
    expect(prisma.otp.delete).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
    });
  });

  it('existing-user login does NOT consult the gate', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({
      id: 'u-existing',
      qiftUsername: 'bob',
      phone: '+966501234567',
      passwordHash: 'hash',
      deletedAt: null,
    });

    const res = await service.register({
      phone: '0501234567',
      code: '123456',
    });

    expect(res.accessToken).toBe('signed-jwt');
    // The gate is bypassed entirely on the login branch.
    expect(beta.decideRegistration).not.toHaveBeenCalled();
    expect(beta.applyRedemption).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txUserCreate).not.toHaveBeenCalled();
  });

  it('gate denial aborts registration before any user is created', async () => {
    // No existing user → new-user branch → gate consulted.
    prisma.user.findFirst.mockResolvedValue(null);
    beta.decideRegistration.mockRejectedValue(
      new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          code: 'beta_required',
          message: 'x',
        },
        HttpStatus.FORBIDDEN,
      ),
    );

    await expect(
      service.register({
        phone: '0509999999',
        code: '123456',
        qiftUsername: 'newbie',
        password: 'password123',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });

    expect(beta.decideRegistration).toHaveBeenCalledTimes(1);
    // No account, no redemption, no OTP consumption.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txUserCreate).not.toHaveBeenCalled();
    expect(beta.applyRedemption).not.toHaveBeenCalled();
    expect(prisma.otp.delete).not.toHaveBeenCalled();
  });

  it('gate approval (code) creates the user AND redeems inside the transaction', async () => {
    prisma.user.findFirst.mockResolvedValue(null); // existing + conflict both null
    const decision = { mode: 'code', codeId: 'c9', maxUses: 5 } as const;
    beta.decideRegistration.mockResolvedValue(decision);
    txUserCreate.mockResolvedValue({
      id: 'u-new',
      qiftUsername: 'newbie',
      phone: '+966509999999',
      passwordHash: 'hash',
    });

    const res = await service.register({
      phone: '0509999999',
      code: '123456',
      qiftUsername: 'newbie',
      password: 'password123',
    });

    expect(res.accessToken).toBe('signed-jwt');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txUserCreate).toHaveBeenCalledTimes(1);
    // Redemption runs with the same tx + the freshly-created user id.
    expect(beta.applyRedemption).toHaveBeenCalledWith(
      expect.anything(),
      decision,
      'u-new',
    );
    // OTP consumed only after a successful commit.
    expect(prisma.otp.delete).toHaveBeenCalledWith({ where: { id: 'otp-1' } });
  });

  it('gate approval (open / allowlist) still creates the user (applyRedemption no-ops)', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const decision = { mode: 'open' } as const;
    beta.decideRegistration.mockResolvedValue(decision);
    txUserCreate.mockResolvedValue({
      id: 'u-open',
      qiftUsername: 'opener',
      phone: '+966508888888',
      passwordHash: 'hash',
    });

    const res = await service.register({
      phone: '0508888888',
      code: '123456',
      qiftUsername: 'opener',
      password: 'password123',
    });

    expect(res.accessToken).toBe('signed-jwt');
    expect(txUserCreate).toHaveBeenCalledTimes(1);
    expect(beta.applyRedemption).toHaveBeenCalledWith(
      expect.anything(),
      decision,
      'u-open',
    );
  });
});
