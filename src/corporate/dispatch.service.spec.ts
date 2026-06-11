// DispatchService unit tests — Corporate Foundation PR 4.
//
// Pinned: the approved-only conditional flip (double-dispatch race →
// one winner, one 409), idempotency-key job shape with
// skipDuplicates, tenant isolation on both endpoints, and the audit
// row.

import { HttpException, NotFoundException } from '@nestjs/common';
import { DispatchService } from './dispatch.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type PrismaMock = {
  giftCampaign: { findFirst: jest.Mock; updateMany: jest.Mock };
  campaignRecipient: { findMany: jest.Mock };
  dispatchJob: { createMany: jest.Mock; groupBy: jest.Mock };
  $transaction: jest.Mock;
};

describe('DispatchService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let service: DispatchService;

  beforeEach(() => {
    prisma = {
      giftCampaign: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'camp-1', status: 'approved' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      campaignRecipient: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ contactId: 'c-1' }, { contactId: 'c-2' }]),
      },
      dispatchJob: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockImplementation((fn) => fn(prisma)),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new DispatchService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('dispatchCampaign', () => {
    it('TENANT ISOLATION: campaign load is keyed (id, orgId)', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(null);
      await expect(
        service.dispatchCampaign('u1', 'org-1', 'camp-of-org-2'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.giftCampaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-of-org-2', orgId: 'org-1' },
        }),
      );
    });

    it.each(['draft', 'pending_approval', 'dispatching', 'completed', 'cancelled'])(
      '409s when the campaign is %s (not approved)',
      async (status) => {
        prisma.giftCampaign.findFirst.mockResolvedValue({
          id: 'camp-1',
          status,
        });
        try {
          await service.dispatchCampaign('u1', 'org-1', 'camp-1');
          throw new Error('expected dispatchCampaign to throw');
        } catch (e) {
          expect(e).toBeInstanceOf(HttpException);
          expect((e as HttpException).getStatus()).toBe(409);
        }
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('enqueues one job per recipient with the idempotency key, inside the flip transaction', async () => {
      const res = await service.dispatchCampaign('u1', 'org-1', 'camp-1');
      expect(res).toEqual({ ok: true, jobs: 2 });
      // The flip is CONDITIONAL on status still being approved.
      expect(prisma.giftCampaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'camp-1', orgId: 'org-1', status: 'approved' },
        data: { status: 'dispatching' },
      });
      expect(prisma.dispatchJob.createMany).toHaveBeenCalledWith({
        data: [
          {
            campaignId: 'camp-1',
            contactId: 'c-1',
            idempotencyKey: 'camp-1:c-1',
          },
          {
            campaignId: 'camp-1',
            contactId: 'c-2',
            idempotencyKey: 'camp-1:c-2',
          },
        ],
        skipDuplicates: true,
      });
    });

    it('DOUBLE-DISPATCH RACE: the loser of the conditional flip gets a 409 and enqueues nothing', async () => {
      prisma.giftCampaign.updateMany.mockResolvedValue({ count: 0 });
      try {
        await service.dispatchCampaign('u1', 'org-1', 'camp-1');
        throw new Error('expected dispatchCampaign to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(409);
      }
      expect(prisma.dispatchJob.createMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('audits the dispatch with the enqueued count', async () => {
      await service.dispatchCampaign('u1', 'org-1', 'camp-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'org.campaign.dispatch',
          targetId: 'org-1',
          metadata: { campaignId: 'camp-1', jobs: 2 },
        }),
      );
    });
  });

  describe('getDispatchStatus', () => {
    it('returns campaign status + per-status job counts, org-scoped', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        status: 'dispatching',
      });
      prisma.dispatchJob.groupBy.mockResolvedValue([
        { status: 'dispatched', _count: { _all: 7 } },
        { status: 'pending', _count: { _all: 2 } },
        { status: 'failed', _count: { _all: 1 } },
      ]);
      const res = await service.getDispatchStatus('org-1', 'camp-1');
      expect(res).toEqual({
        campaignStatus: 'dispatching',
        jobs: { dispatched: 7, pending: 2, failed: 1 },
      });
    });

    it('404s across tenants', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(null);
      await expect(
        service.getDispatchStatus('org-1', 'camp-x'),
      ).rejects.toThrow('campaign_not_found');
    });
  });
});
