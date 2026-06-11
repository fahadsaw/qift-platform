// ClaimMintService unit tests — Corporate Foundation PR 5.
//
// Pinned: token-at-rest hygiene (only the hash persists; the URL
// carries the raw token), jobId idempotency (re-mint ROTATES the
// token instead of duplicating the gift), finalized-claim
// protection, and the unreachable/snapshotless permanent failures.

import { ClaimMintService } from './claim-mint.service';
import { hashClaimToken } from './claim-token';
import type { PrismaService } from '../prisma/prisma.service';

describe('ClaimMintService', () => {
  let prisma: {
    claimableGift: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    corporateContact: { findUnique: jest.Mock };
    giftCampaign: { findUnique: jest.Mock };
  };
  let service: ClaimMintService;
  const ORIGINAL_BASE = process.env.QIFT_CLAIM_BASE_URL;

  const input = { jobId: 'job-1', campaignId: 'camp-1', contactId: 'c-1' };

  beforeEach(() => {
    prisma = {
      claimableGift: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'claim-1' }),
        update: jest.fn().mockResolvedValue({ id: 'claim-1' }),
      },
      corporateContact: {
        findUnique: jest.fn().mockResolvedValue({
          fullName: 'سارة العتيبي',
          phone: '+966501234567',
          email: null,
        }),
      },
      giftCampaign: {
        findUnique: jest.fn().mockResolvedValue({
          message: 'كل عام وأنتم بخير',
          org: { displayName: 'Acme', displayNameAr: 'أكمي' },
          options: [
            { approvalSnapshot: { productName: 'علبة تمر', storeId: 's-1' } },
          ],
        }),
      },
    };
    service = new ClaimMintService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    if (ORIGINAL_BASE === undefined) delete process.env.QIFT_CLAIM_BASE_URL;
    else process.env.QIFT_CLAIM_BASE_URL = ORIGINAL_BASE;
    jest.clearAllMocks();
  });

  it('mints a claim whose RAW token exists only in the URL (hash at rest)', async () => {
    const res = await service.mintForJob(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { data } = prisma.claimableGift.create.mock.calls[0][0];
    const rawToken = res.claimUrl.split('/claim/')[1];
    expect(rawToken.length).toBeGreaterThanOrEqual(32);
    expect(data.tokenHash).toBe(hashClaimToken(rawToken));
    expect(data.tokenHash).not.toBe(rawToken);
    expect(JSON.stringify(data)).not.toContain(rawToken);
  });

  it('snapshots recipient, channel, org (Arabic name preferred), message, gift', async () => {
    await service.mintForJob(input);
    const { data } = prisma.claimableGift.create.mock.calls[0][0];
    expect(data).toMatchObject({
      jobId: 'job-1',
      campaignId: 'camp-1',
      contactId: 'c-1',
      recipientName: 'سارة العتيبي',
      channel: 'phone',
      channelValue: '+966501234567',
      orgDisplayName: 'أكمي',
      campaignMessage: 'كل عام وأنتم بخير',
      giftSnapshot: { productName: 'علبة تمر', storeId: 's-1' },
    });
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('IDEMPOTENT BY JOB: a pending claim is token-ROTATED, never duplicated', async () => {
    prisma.claimableGift.findUnique.mockResolvedValue({
      id: 'claim-1',
      status: 'pending',
    });
    const res = await service.mintForJob(input);
    expect(res.ok).toBe(true);
    expect(prisma.claimableGift.create).not.toHaveBeenCalled();
    expect(prisma.claimableGift.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'claim-1' } }),
    );
  });

  it('refuses to touch a finalized claim (claimed gifts are irrevocable)', async () => {
    prisma.claimableGift.findUnique.mockResolvedValue({
      id: 'claim-1',
      status: 'claimed',
    });
    const res = await service.mintForJob(input);
    expect(res).toEqual({ ok: false, error: 'claim_already_finalized' });
    expect(prisma.claimableGift.update).not.toHaveBeenCalled();
  });

  it('fails permanently on a purged / channel-less contact', async () => {
    prisma.corporateContact.findUnique.mockResolvedValue(null);
    expect(await service.mintForJob(input)).toEqual({
      ok: false,
      error: 'contact_unreachable',
    });
  });

  it('fails permanently when the campaign has no approval snapshot', async () => {
    prisma.giftCampaign.findUnique.mockResolvedValue({
      message: null,
      org: { displayName: 'Acme', displayNameAr: null },
      options: [{ approvalSnapshot: null }],
    });
    expect(await service.mintForJob(input)).toEqual({
      ok: false,
      error: 'campaign_snapshot_missing',
    });
  });

  it('respects QIFT_CLAIM_BASE_URL', async () => {
    process.env.QIFT_CLAIM_BASE_URL = 'https://staging.qift.net/';
    const res = await service.mintForJob(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claimUrl).toMatch(/^https:\/\/staging\.qift\.net\/claim\//);
    }
  });
});
