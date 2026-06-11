// ReportService unit tests — Corporate Foundation PR 6.
//
// These are the WRITTEN REPORTING-PRIVACY TESTS:
//
//   * F7 NON-PARTICIPATION COLLAPSE — declined / expired / mismatch /
//     revoked are ONE number on the org plane. Two campaigns whose
//     non-participation differs only in REASON produce identical
//     org reports.
//   * SHAPE CONTRACT — the org report is integers + campaign meta.
//     No status-name keys, no recipient identity, no reviewer
//     identity. Adding a key is a privacy change.
//   * Ops plane keeps full granularity (mismatch visible) — counts
//     only, never identities.
//   * Tenant isolation on both planes.

import { NotFoundException } from '@nestjs/common';
import {
  NON_PARTICIPATION_STATUSES,
  ReportService,
} from './report.service';
import type { PrismaService } from '../prisma/prisma.service';

type Group = { status: string; _count: { _all: number } };

const groups = (m: Record<string, number>): Group[] =>
  Object.entries(m).map(([status, n]) => ({ status, _count: { _all: n } }));

const campaignRow = {
  id: 'camp-1',
  name: 'Eid 2026',
  occasion: 'Eid',
  status: 'completed',
  submittedAt: new Date('2026-06-01'),
  approvedAt: new Date('2026-06-02'),
  createdAt: new Date('2026-05-30'),
};

describe('ReportService', () => {
  let prisma: {
    giftCampaign: { findFirst: jest.Mock };
    campaignRecipient: { count: jest.Mock };
    dispatchJob: { groupBy: jest.Mock };
    claimableGift: { groupBy: jest.Mock };
  };
  let service: ReportService;

  beforeEach(() => {
    prisma = {
      giftCampaign: { findFirst: jest.fn().mockResolvedValue(campaignRow) },
      campaignRecipient: { count: jest.fn().mockResolvedValue(10) },
      dispatchJob: {
        groupBy: jest.fn().mockResolvedValue(groups({ dispatched: 10 })),
      },
      claimableGift: { groupBy: jest.fn().mockResolvedValue(groups({})) },
    };
    service = new ReportService(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  // ═════════════════════════════════════════════════════════════════
  describe('F7 — non-participation collapse', () => {
    it.each(NON_PARTICIPATION_STATUSES.map((s) => [s]))(
      'a %s claim is just "did not participate" on the org plane',
      async (status) => {
        prisma.claimableGift.groupBy.mockResolvedValue(
          groups({ claimed: 7, pending: 1, [status]: 2 }),
        );
        const report = await service.orgCampaignReport('org-1', 'camp-1');
        expect(report.gifts).toEqual({
          issued: 10,
          claimed: 7,
          pending: 1,
          didNotParticipate: 2,
        });
        // The reason must not appear ANYWHERE in the payload.
        expect(JSON.stringify(report)).not.toContain(status);
      },
    );

    it('two campaigns differing ONLY in non-participation reason are indistinguishable', async () => {
      prisma.claimableGift.groupBy.mockResolvedValueOnce(
        groups({ claimed: 6, pending: 1, declined: 3 }),
      );
      const declinedReport = await service.orgCampaignReport('org-1', 'camp-1');

      prisma.claimableGift.groupBy.mockResolvedValueOnce(
        groups({ claimed: 6, pending: 1, expired: 1, mismatch: 1, revoked: 1 }),
      );
      const mixedReport = await service.orgCampaignReport('org-1', 'camp-1');

      expect(declinedReport).toEqual(mixedReport);
    });

    it('an unanticipated FUTURE terminal status still folds into the bucket (derived by subtraction)', async () => {
      prisma.claimableGift.groupBy.mockResolvedValue(
        groups({ claimed: 5, pending: 2, opted_out: 3 }),
      );
      const report = await service.orgCampaignReport('org-1', 'camp-1');
      expect(report.gifts.didNotParticipate).toBe(3);
      expect(JSON.stringify(report)).not.toContain('opted_out');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('shape contract — aggregate counts only', () => {
    it('the org report is EXACTLY campaign meta + integers, nothing more', async () => {
      prisma.claimableGift.groupBy.mockResolvedValue(
        groups({ claimed: 4, pending: 6 }),
      );
      const report = await service.orgCampaignReport('org-1', 'camp-1');
      expect(Object.keys(report).sort()).toEqual([
        'campaign',
        'dispatched',
        'gifts',
        'recipients',
      ]);
      expect(Object.keys(report.gifts).sort()).toEqual([
        'claimed',
        'didNotParticipate',
        'issued',
        'pending',
      ]);
      expect(typeof report.recipients).toBe('number');
      expect(typeof report.dispatched).toBe('number');
      for (const v of Object.values(report.gifts)) {
        expect(typeof v).toBe('number');
      }
    });

    it('never selects recipient or reviewer identity from the database', async () => {
      await service.orgCampaignReport('org-1', 'camp-1');
      const select = prisma.giftCampaign.findFirst.mock.calls[0][0].select;
      expect(select.recipients).toBeUndefined();
      expect(select.createdBy).toBeUndefined();
      expect(select.approvedBy).toBeUndefined();
      // Counts come from count/groupBy — never findMany over claims
      // or recipients, so a row-level field can't leak by accident.
      expect(prisma.claimableGift.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['status'] }),
      );
    });

    it('a fresh campaign (nothing dispatched) reports clean zeros', async () => {
      prisma.dispatchJob.groupBy.mockResolvedValue(groups({}));
      const report = await service.orgCampaignReport('org-1', 'camp-1');
      expect(report.dispatched).toBe(0);
      expect(report.gifts).toEqual({
        issued: 0,
        claimed: 0,
        pending: 0,
        didNotParticipate: 0,
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('ops plane — full granularity, counts only', () => {
    it('keeps the per-status breakdown (mismatch visible to ops)', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue({
        ...campaignRow,
        createdBy: 'maker-1',
        approvedBy: 'checker-1',
      });
      prisma.dispatchJob.groupBy.mockResolvedValue(
        groups({ dispatched: 8, failed: 2 }),
      );
      prisma.claimableGift.groupBy.mockResolvedValue(
        groups({ claimed: 5, pending: 1, mismatch: 1, declined: 1 }),
      );
      const report = await service.adminCampaignReport('org-1', 'camp-1');
      expect(report.jobs).toEqual({ dispatched: 8, failed: 2 });
      expect(report.claims).toEqual({
        claimed: 5,
        pending: 1,
        mismatch: 1,
        declined: 1,
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('tenant isolation', () => {
    it('org report is keyed (id, orgId) — cross-org reads as missing', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(null);
      await expect(
        service.orgCampaignReport('org-1', 'camp-of-org-2'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.giftCampaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-of-org-2', orgId: 'org-1' },
        }),
      );
    });

    it('admin report is keyed the same way', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(null);
      await expect(
        service.adminCampaignReport('org-1', 'camp-x'),
      ).rejects.toThrow('campaign_not_found');
    });
  });
});
