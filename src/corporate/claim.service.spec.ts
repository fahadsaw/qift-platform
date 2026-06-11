// ClaimService unit tests — Corporate Foundation PR 5.
//
// The first block is the WRITTEN F1 ACCEPTANCE TEST the Corporate
// Core v2 review demanded: nothing identifying (recipient name,
// company, gift) appears on any pre-OTP surface. Then:
// anti-enumeration (all dead tokens are the same 404), OTP binding
// (the recipient never supplies a target), session mechanics,
// first-class exits (not-me / decline), coverage-checked address,
// irrevocability, and audit PII hygiene.

import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClaimService } from './claim.service';
import { hashClaimToken } from './claim-token';
import { matchAddressToStoreZones } from '../stores/delivery-zones';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { OtpService } from '../otp/otp.service';

jest.mock('../stores/delivery-zones', () => ({
  matchAddressToStoreZones: jest.fn(),
}));
const matchMock = matchAddressToStoreZones as jest.Mock;

const TOKEN = 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION = 'ses-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Identity strings that must NEVER appear pre-OTP.
const RECIPIENT = 'سارة العتيبي';
const ORG = 'شركة أكمي للتجارة';
const PRODUCT = 'علبة تمر فاخرة';

const claimRow = (over: Record<string, unknown> = {}) => ({
  id: 'claim-1',
  campaignId: 'camp-1',
  contactId: 'c-1',
  jobId: 'job-1',
  tokenHash: hashClaimToken(TOKEN),
  status: 'pending',
  recipientName: RECIPIENT,
  channel: 'phone',
  channelValue: '+966501234567',
  orgDisplayName: ORG,
  campaignMessage: 'كل عام وأنتم بخير',
  giftSnapshot: {
    productId: 'prod-1',
    productName: PRODUCT,
    price: 149.5,
    category: 'dates',
    storeId: 'store-1',
    storeName: 'متجر التمور',
  },
  sessionTokenHash: null,
  sessionExpiresAt: null,
  otpVerifiedAt: null,
  claimedAt: null,
  declinedAt: null,
  expiresAt: new Date(Date.now() + 7 * 86_400_000),
  ...over,
});

const liveSession = () => ({
  sessionTokenHash: hashClaimToken(SESSION),
  sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
  otpVerifiedAt: new Date(),
});

describe('ClaimService', () => {
  let prisma: {
    claimableGift: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    claimAddress: { create: jest.Mock };
    store: { findUnique: jest.Mock };
    product: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let otp: { send: jest.Mock; verify: jest.Mock };
  let service: ClaimService;

  beforeEach(() => {
    prisma = {
      claimableGift: {
        findUnique: jest.fn().mockResolvedValue(claimRow()),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      claimAddress: { create: jest.fn().mockResolvedValue({ id: 'addr-1' }) },
      store: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ city: 'الرياض', deliveryZones: [] }),
      },
      product: {
        findUnique: jest.fn().mockResolvedValue({ isFastDelivery: false }),
      },
      $transaction: jest.fn().mockImplementation((fn) => fn(prisma)),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    otp = {
      send: jest.fn().mockResolvedValue({ ok: true }),
      verify: jest.fn().mockResolvedValue({ ok: true }),
    };
    matchMock.mockReturnValue({ ok: true });
    service = new ClaimService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      otp as unknown as OtpService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  const goodAddress = {
    phone: '0501234567',
    country: 'SA',
    city: 'الرياض',
    line1: 'حي الياسمين، شارع ١٢',
  };

  // ═════════════════════════════════════════════════════════════════
  // F1 ACCEPTANCE: nothing identifying before OTP.
  // ═════════════════════════════════════════════════════════════════
  describe('F1 — pre-OTP surfaces are generic', () => {
    it('teaser carries NO recipient name, NO org, NO gift — only a masked channel hint', async () => {
      const res = await service.teaser(TOKEN);
      expect(res).toEqual({
        ok: true,
        channel: 'phone',
        channelHint: '•••••••67',
      });
      const wire = JSON.stringify(res);
      expect(wire).not.toContain(RECIPIENT);
      expect(wire).not.toContain(ORG);
      expect(wire).not.toContain(PRODUCT);
      expect(wire).not.toContain('+966501234567'); // full channel masked too
    });

    it('send-otp response is equally generic', async () => {
      const res = await service.sendOtp(TOKEN);
      const wire = JSON.stringify(res);
      expect(wire).not.toContain(RECIPIENT);
      expect(wire).not.toContain(ORG);
      expect(wire).not.toContain(PRODUCT);
    });

    it('identity echo + gift appear ONLY after OTP verification', async () => {
      const res = await service.verifyOtp(TOKEN, '123456');
      expect(res.claim.recipientName).toBe(RECIPIENT);
      expect(res.claim.orgDisplayName).toBe(ORG);
      expect((res.claim.gift as { productName: string }).productName).toBe(
        PRODUCT,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('anti-enumeration', () => {
    it('an unknown token is 404 claim_not_found', async () => {
      prisma.claimableGift.findUnique.mockResolvedValue(null);
      await expect(service.teaser(TOKEN)).rejects.toThrow('claim_not_found');
    });

    it.each(['claimed', 'declined', 'mismatch', 'expired', 'revoked'])(
      'a %s claim is INDISTINGUISHABLE from a missing one',
      async (status) => {
        prisma.claimableGift.findUnique.mockResolvedValue(
          claimRow({ status }),
        );
        await expect(service.teaser(TOKEN)).rejects.toThrow('claim_not_found');
      },
    );

    it('an expired pending claim is lazily marked and returns the SAME 404', async () => {
      prisma.claimableGift.findUnique.mockResolvedValue(
        claimRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.teaser(TOKEN)).rejects.toThrow('claim_not_found');
      expect(prisma.claimableGift.updateMany).toHaveBeenCalledWith({
        where: { id: 'claim-1', status: 'pending' },
        data: { status: 'expired' },
      });
    });

    it('garbage / short tokens 404 without touching the database', async () => {
      await expect(service.teaser('short')).rejects.toThrow(NotFoundException);
      expect(prisma.claimableGift.findUnique).not.toHaveBeenCalled();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('OTP binding', () => {
    it('sends the OTP to the BOUND channel — the recipient never supplies a target', async () => {
      await service.sendOtp(TOKEN);
      expect(otp.send).toHaveBeenCalledWith({
        target: '+966501234567',
        type: 'phone',
      });
    });

    it('email-bound claims OTP via email', async () => {
      prisma.claimableGift.findUnique.mockResolvedValue(
        claimRow({ channel: 'email', channelValue: 'sara@corp.sa' }),
      );
      await service.sendOtp(TOKEN);
      expect(otp.send).toHaveBeenCalledWith({
        target: 'sara@corp.sa',
        type: 'email',
      });
    });

    it('a wrong code propagates OtpService rejection and mints NO session', async () => {
      otp.verify.mockRejectedValue(new BadRequestException('invalid_code'));
      await expect(service.verifyOtp(TOKEN, '000000')).rejects.toThrow(
        'invalid_code',
      );
      expect(prisma.claimableGift.update).not.toHaveBeenCalled();
    });

    it('a correct code mints a hashed 30-minute session', async () => {
      const res = await service.verifyOtp(TOKEN, '123456');
      expect(otp.verify).toHaveBeenCalledWith({
        target: '+966501234567',
        code: '123456',
      });
      const { data } = prisma.claimableGift.update.mock.calls[0][0];
      expect(data.sessionTokenHash).toBe(hashClaimToken(res.sessionToken));
      expect(data.sessionTokenHash).not.toBe(res.sessionToken); // hashed at rest
      expect(data.sessionExpiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(data.otpVerifiedAt).toBeInstanceOf(Date);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('session mechanics', () => {
    it('reveal requires a live matching session', async () => {
      prisma.claimableGift.findUnique.mockResolvedValue(
        claimRow(liveSession()),
      );
      const res = await service.reveal(TOKEN, SESSION);
      expect(res.claim.recipientName).toBe(RECIPIENT);
    });

    it.each([
      ['wrong token', { ...liveSession(), sessionTokenHash: 'nope' }],
      ['expired session', { ...liveSession(), sessionExpiresAt: new Date(Date.now() - 1) }],
      ['no OTP ever verified', { ...liveSession(), otpVerifiedAt: null }],
      ['no session minted', {}],
    ])('rejects: %s', async (_label, over) => {
      prisma.claimableGift.findUnique.mockResolvedValue(claimRow(over));
      await expect(service.reveal(TOKEN, SESSION)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('first-class exits', () => {
    beforeEach(() =>
      prisma.claimableGift.findUnique.mockResolvedValue(
        claimRow(liveSession()),
      ),
    );

    it('"this isn\'t me" finalizes to mismatch with a PII-free audit row', async () => {
      await service.notMe(TOKEN, SESSION);
      expect(prisma.claimableGift.updateMany).toHaveBeenCalledWith({
        where: { id: 'claim-1', status: 'pending' },
        data: { status: 'mismatch' },
      });
      const call = audit.record.mock.calls[0][0];
      expect(call.action).toBe('corporate.claim.mismatch');
      const wire = JSON.stringify(call);
      expect(wire).not.toContain(RECIPIENT);
      expect(wire).not.toContain('+966');
    });

    it('decline finalizes with declinedAt', async () => {
      await service.decline(TOKEN, SESSION);
      const arg = prisma.claimableGift.updateMany.mock.calls[0][0];
      expect(arg.data.status).toBe('declined');
      expect(arg.data.declinedAt).toBeInstanceOf(Date);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('address — coverage + irrevocability', () => {
    beforeEach(() =>
      prisma.claimableGift.findUnique.mockResolvedValue(
        claimRow(liveSession()),
      ),
    );

    it('validates the delivery phone and required fields', async () => {
      await expect(
        service.submitAddress(TOKEN, SESSION, { ...goodAddress, phone: '12' }),
      ).rejects.toThrow('address_phone_invalid');
      await expect(
        service.submitAddress(TOKEN, SESSION, { ...goodAddress, city: ' ' }),
      ).rejects.toThrow('address_fields_required');
    });

    it('out-of-coverage address is a calm, retryable 400 — nothing finalizes', async () => {
      matchMock.mockReturnValue({ ok: false });
      prisma.product.findUnique.mockResolvedValue({ isFastDelivery: true });
      await expect(
        service.submitAddress(TOKEN, SESSION, goodAddress),
      ).rejects.toThrow('address_out_of_coverage');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.claimAddress.create).not.toHaveBeenCalled();
    });

    it('coverage is checked against the snapshotted store with the fast-delivery rule', async () => {
      prisma.product.findUnique.mockResolvedValue({ isFastDelivery: true });
      await service.submitAddress(TOKEN, SESSION, goodAddress);
      expect(prisma.store.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'store-1' } }),
      );
      expect(matchMock).toHaveBeenCalledWith(
        expect.objectContaining({ city: 'الرياض', country: 'SA' }),
        expect.objectContaining({ city: 'الرياض' }),
        true,
      );
    });

    it('a vanished store does not block the claim (ops-manual fulfillment)', async () => {
      prisma.store.findUnique.mockResolvedValue(null);
      await expect(
        service.submitAddress(TOKEN, SESSION, goodAddress),
      ).resolves.toEqual({ ok: true, status: 'claimed' });
      expect(matchMock).not.toHaveBeenCalled();
    });

    it('claims atomically: conditional flip + address row; normalized phone stored', async () => {
      await service.submitAddress(TOKEN, SESSION, goodAddress);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.claimableGift.updateMany).toHaveBeenCalledWith({
        where: { id: 'claim-1', status: 'pending' },
        data: { status: 'claimed', claimedAt: expect.any(Date) },
      });
      expect(prisma.claimAddress.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          claimId: 'claim-1',
          phone: '+966501234567',
          city: 'الرياض',
          line1: 'حي الياسمين، شارع ١٢',
        }),
      });
    });

    it('IRREVOCABLE: a lost flip race finalizes nothing twice', async () => {
      prisma.claimableGift.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.submitAddress(TOKEN, SESSION, goodAddress),
      ).rejects.toThrow('claim_already_finalized');
      expect(prisma.claimAddress.create).not.toHaveBeenCalled();
    });

    it('the claimed audit row never contains the address', async () => {
      await service.submitAddress(TOKEN, SESSION, goodAddress);
      const wire = JSON.stringify(audit.record.mock.calls[0][0]);
      expect(wire).not.toContain('الياسمين');
      expect(wire).not.toContain('الرياض');
      expect(wire).not.toContain('+966');
    });
  });
});
