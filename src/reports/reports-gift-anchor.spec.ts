// Dispute gift-anchoring (Track A.5 PR 9).
//
// Pinned: a report may anchor the gift it is about ONLY when the
// reporter is a party (sender/receiver). Strangers cannot anchor other
// people's gifts; a missing gift 404s; no anchor stays legal.

import { ReportsService } from './reports.service';
import type { PrismaService } from '../prisma/prisma.service';

function mk() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'u-bad', deletedAt: null }),
    },
    gift: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ senderId: 'u-sender', receiverId: 'u-recv' }),
    },
    report: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 'r-1', ...data }),
        ),
    },
  };
  const service = new ReportsService(prisma as unknown as PrismaService);
  return { prisma, service };
}

const BASE = { reportedUserId: 'u-bad', reason: 'other', details: 'issue' };

describe('ReportsService gift anchoring', () => {
  it('a PARTY to the gift can anchor it; giftId persists', async () => {
    const { prisma, service } = mk();
    await service.create('u-sender', { ...BASE, giftId: 'g-1' });
    expect(prisma.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ giftId: 'g-1' }),
      }),
    );
  });

  it("a STRANGER cannot anchor someone else's gift", async () => {
    const { prisma, service } = mk();
    await expect(
      service.create('u-stranger', { ...BASE, giftId: 'g-1' }),
    ).rejects.toThrow('gift_not_yours');
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('an unknown gift 404s', async () => {
    const { prisma, service } = mk();
    prisma.gift.findUnique.mockResolvedValue(null);
    await expect(
      service.create('u-sender', { ...BASE, giftId: 'nope' }),
    ).rejects.toThrow('gift_not_found');
  });

  it('no anchor remains valid — giftId persists as null', async () => {
    const { prisma, service } = mk();
    await service.create('u-sender', BASE);
    expect(prisma.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ giftId: null }),
      }),
    );
  });
});
