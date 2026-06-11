// ClaimExportService unit tests — Corporate Foundation PR 7b.
//
// Pinned, in the order the scope demanded:
//
//   * PRIVACY — the payload is contactName + channel + claimUrl
//     and nothing else: no channel values, no addresses (the
//     service never touches ClaimAddress — the mock doesn't even
//     have it), and the audit row carries counts, never URLs.
//   * TOKEN ROTATION — every dispatched job is re-minted through
//     ClaimMintService (which rotates pending claims); fresh URLs
//     come back per call.
//   * FINALIZED REFUSAL — mint's claim_already_finalized becomes a
//     skip, never a link.
//   * TENANT ISOLATION — campaign keyed (id, orgId).

import { NotFoundException } from '@nestjs/common';
import { ClaimExportService } from './claim-export.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { ClaimMintService } from './claim-mint.service';

const PHONE = '+966501234567';

describe('ClaimExportService', () => {
  let prisma: {
    giftCampaign: { findFirst: jest.Mock };
    dispatchJob: { findMany: jest.Mock };
    corporateContact: { findUnique: jest.Mock };
    // Deliberately NO claimAddress delegate: if the service ever
    // reached for it, the test would crash. ClaimAddress is
    // write-only platform-wide.
  };
  let claimMint: { mintForJob: jest.Mock };
  let audit: { record: jest.Mock };
  let service: ClaimExportService;

  beforeEach(() => {
    prisma = {
      giftCampaign: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'camp-1', name: 'Eid 2026', status: 'completed' }),
      },
      dispatchJob: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'job-1', contactId: 'c-1' },
          { id: 'job-2', contactId: 'c-2' },
        ]),
      },
      corporateContact: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ fullName: 'سارة العتيبي', phone: PHONE }),
      },
    };
    claimMint = {
      mintForJob: jest
        .fn()
        .mockImplementation(({ jobId }: { jobId: string }) =>
          Promise.resolve({
            ok: true,
            claimId: `claim-${jobId}`,
            claimUrl: `https://www.qift.net/claim/fresh-${jobId}`,
          }),
        ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ClaimExportService(
      prisma as unknown as PrismaService,
      claimMint as unknown as ClaimMintService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ═════════════════════════════════════════════════════════════════
  describe('privacy', () => {
    it('each link is EXACTLY { contactName, channel, claimUrl } — channel value never leaves', async () => {
      const res = await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      expect(res.links).toHaveLength(2);
      for (const link of res.links) {
        expect(Object.keys(link).sort()).toEqual([
          'channel',
          'claimUrl',
          'contactName',
        ]);
      }
      expect(res.links[0]).toEqual({
        contactName: 'سارة العتيبي',
        channel: 'phone',
        claimUrl: 'https://www.qift.net/claim/fresh-job-1',
      });
      // The phone NUMBER appears nowhere in the response.
      expect(JSON.stringify(res)).not.toContain(PHONE);
    });

    it('top-level shape is pinned — no address-shaped keys can sneak in', async () => {
      const res = await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      expect(Object.keys(res).sort()).toEqual([
        'campaign',
        'exported',
        'links',
        'skippedFinalized',
        'skippedUnreachable',
      ]);
    });

    it('the audit row carries counts, NEVER claim URLs', async () => {
      await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      expect(audit.record).toHaveBeenCalledWith({
        actorUserId: 'ops-1',
        actorType: 'admin',
        action: 'admin.org.claim_links.export',
        targetType: 'organization',
        targetId: 'org-1',
        metadata: {
          campaignId: 'camp-1',
          exported: 2,
          skippedFinalized: 0,
          skippedUnreachable: 0,
        },
      });
      expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain(
        '/claim/',
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('token rotation', () => {
    it('re-mints every DISPATCHED job through ClaimMintService', async () => {
      await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      expect(prisma.dispatchJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { campaignId: 'camp-1', status: 'dispatched' },
        }),
      );
      expect(claimMint.mintForJob).toHaveBeenCalledTimes(2);
      expect(claimMint.mintForJob).toHaveBeenNthCalledWith(1, {
        jobId: 'job-1',
        campaignId: 'camp-1',
        contactId: 'c-1',
      });
    });

    it('two exports produce two distinct link sets (rotation is the mint’s job; the export just reflects it)', async () => {
      const first = await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      claimMint.mintForJob.mockImplementation(({ jobId }: { jobId: string }) =>
        Promise.resolve({
          ok: true,
          claimId: `claim-${jobId}`,
          claimUrl: `https://www.qift.net/claim/rotated-${jobId}`,
        }),
      );
      const second = await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      expect(first.links[0].claimUrl).not.toBe(second.links[0].claimUrl);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('finalized refusal', () => {
    it('a finalized claim becomes a skip, never a link', async () => {
      claimMint.mintForJob
        .mockResolvedValueOnce({ ok: false, error: 'claim_already_finalized' })
        .mockResolvedValueOnce({
          ok: true,
          claimId: 'claim-job-2',
          claimUrl: 'https://www.qift.net/claim/fresh-job-2',
        });
      const res = await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      expect(res.exported).toBe(1);
      expect(res.skippedFinalized).toBe(1);
      expect(res.links).toHaveLength(1);
      expect(res.links[0].claimUrl).toContain('job-2');
    });

    it('an unreachable (purged) contact is skipped separately', async () => {
      claimMint.mintForJob
        .mockResolvedValueOnce({ ok: false, error: 'contact_unreachable' })
        .mockResolvedValueOnce({
          ok: true,
          claimId: 'claim-job-2',
          claimUrl: 'https://www.qift.net/claim/fresh-job-2',
        });
      const res = await service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-1');
      expect(res.skippedUnreachable).toBe(1);
      expect(res.exported).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('tenant isolation', () => {
    it('campaign is keyed (id, orgId) — another org’s campaign reads as missing', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(null);
      await expect(
        service.exportCampaignClaimLinks('ops-1', 'org-1', 'camp-of-org-2'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.giftCampaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-of-org-2', orgId: 'org-1' },
        }),
      );
      expect(claimMint.mintForJob).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
