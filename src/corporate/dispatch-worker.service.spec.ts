// DispatchWorkerService unit tests — Corporate Foundation PR 4.
//
// Pinned: atomic job claiming (lost race = silent skip), live
// channel resolution (phone over email, nothing persisted on the
// job), provider settle paths (ok / retry / permanent / attempts
// exhausted), unreachable-contact permanent failure, the pause
// brake, campaign completion semantics (failed jobs don't block),
// and the no-timer-under-test guarantee.

import { DispatchWorkerService, MAX_DISPATCH_ATTEMPTS } from './dispatch-worker.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { DispatchProvider } from './dispatch-provider';
import type { ClaimMintService } from './claim-mint.service';

type PrismaMock = {
  dispatchJob: { findMany: jest.Mock; updateMany: jest.Mock };
  corporateContact: { findUnique: jest.Mock };
  giftCampaign: { updateMany: jest.Mock };
};

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  campaignId: 'camp-1',
  contactId: 'c-1',
  attempts: 0,
  claimRef: null,
  ...over,
});

describe('DispatchWorkerService', () => {
  let prisma: PrismaMock;
  let provider: { name: string; deliver: jest.Mock };
  let claimMint: { mintForJob: jest.Mock };
  let service: DispatchWorkerService;
  const ORIGINAL_PAUSED = process.env.QIFT_DISPATCH_PAUSED;
  const ORIGINAL_ENABLED = process.env.QIFT_DISPATCH_WORKER_ENABLED;

  beforeEach(() => {
    prisma = {
      dispatchJob: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      corporateContact: {
        findUnique: jest.fn().mockResolvedValue({
          phone: '+966501234567',
          email: 'sara@corp.sa',
        }),
      },
      giftCampaign: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    provider = { name: 'mock', deliver: jest.fn().mockResolvedValue({ ok: true }) };
    claimMint = {
      mintForJob: jest.fn().mockResolvedValue({
        ok: true,
        claimId: 'claim-1',
        claimUrl: 'https://www.qift.net/claim/tok-x',
      }),
    };
    service = new DispatchWorkerService(
      prisma as unknown as PrismaService,
      provider as unknown as DispatchProvider,
      claimMint as unknown as ClaimMintService,
    );
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore('QIFT_DISPATCH_PAUSED', ORIGINAL_PAUSED);
    restore('QIFT_DISPATCH_WORKER_ENABLED', ORIGINAL_ENABLED);
    service.onModuleDestroy();
    jest.clearAllMocks();
  });

  it('happy path: claims, resolves channel live (phone first), delivers, settles dispatched', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([job()]);
    const res = await service.runOnce();
    expect(res).toMatchObject({ processed: 1, dispatched: 1, failed: 0 });

    // Claim is conditional pending → processing with attempt count.
    expect(prisma.dispatchJob.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'job-1', status: 'pending' },
      data: { status: 'processing', attempts: { increment: 1 } },
    });
    // Phone wins over email; the minted claim URL rides along.
    expect(claimMint.mintForJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      campaignId: 'camp-1',
      contactId: 'c-1',
    });
    expect(provider.deliver).toHaveBeenCalledWith({
      jobId: 'job-1',
      campaignId: 'camp-1',
      contactId: 'c-1',
      channel: 'phone',
      channelValue: '+966501234567',
      claimUrl: 'https://www.qift.net/claim/tok-x',
    });
    // Settle records the claim ref but no channel value.
    const settle = prisma.dispatchJob.updateMany.mock.calls[1][0];
    expect(settle.data.status).toBe('dispatched');
    expect(settle.data.processedAt).toBeInstanceOf(Date);
    expect(settle.data.claimRef).toBe('claim-1');
    expect(JSON.stringify(settle.data)).not.toContain('+966');
  });

  it('mint failure → permanent job failure, provider never called', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([job()]);
    claimMint.mintForJob.mockResolvedValue({
      ok: false,
      error: 'campaign_snapshot_missing',
    });
    const res = await service.runOnce();
    expect(res.failed).toBe(1);
    expect(provider.deliver).not.toHaveBeenCalled();
    expect(prisma.dispatchJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'job-1', status: 'processing' },
      data: { status: 'failed', lastError: 'campaign_snapshot_missing' },
    });
  });

  it('falls back to email when the contact has no phone', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([job()]);
    prisma.corporateContact.findUnique.mockResolvedValue({
      phone: null,
      email: 'sara@corp.sa',
    });
    await service.runOnce();
    expect(provider.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', channelValue: 'sara@corp.sa' }),
    );
  });

  it('lost claim race → silent skip, provider never called', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([job()]);
    prisma.dispatchJob.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await service.runOnce();
    expect(res.processed).toBe(0);
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it('purged / channel-less contact → permanent failure, no retry', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([job()]);
    prisma.corporateContact.findUnique.mockResolvedValue(null);
    const res = await service.runOnce();
    expect(res.failed).toBe(1);
    expect(prisma.dispatchJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'job-1', status: 'processing' },
      data: { status: 'failed', lastError: 'contact_unreachable' },
    });
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it('retryable provider error → back to pending while attempts remain', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([job({ attempts: 0 })]);
    provider.deliver.mockResolvedValue({ ok: false, error: 'timeout' });
    const res = await service.runOnce();
    expect(res.retried).toBe(1);
    expect(prisma.dispatchJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'job-1', status: 'processing' },
      data: { status: 'pending', lastError: 'timeout' },
    });
  });

  it('attempts exhausted → failed', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([
      job({ attempts: MAX_DISPATCH_ATTEMPTS - 1 }),
    ]);
    provider.deliver.mockResolvedValue({ ok: false, error: 'timeout' });
    const res = await service.runOnce();
    expect(res.failed).toBe(1);
    expect(prisma.dispatchJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'job-1', status: 'processing' },
      data: { status: 'failed', lastError: 'timeout' },
    });
  });

  it('permanent provider error → failed immediately, attempts ignored', async () => {
    prisma.dispatchJob.findMany.mockResolvedValue([job({ attempts: 0 })]);
    provider.deliver.mockResolvedValue({
      ok: false,
      error: 'invalid_channel',
      permanent: true,
    });
    const res = await service.runOnce();
    expect(res.failed).toBe(1);
    expect(res.retried).toBe(0);
  });

  it('PAUSE BRAKE: QIFT_DISPATCH_PAUSED=true short-circuits without touching jobs', async () => {
    process.env.QIFT_DISPATCH_PAUSED = 'true';
    const res = await service.runOnce();
    expect(res.paused).toBe(true);
    expect(prisma.dispatchJob.findMany).not.toHaveBeenCalled();
    expect(prisma.dispatchJob.updateMany).not.toHaveBeenCalled();
  });

  it('completion: dispatching campaigns with no live jobs flip to completed (failed jobs do not block)', async () => {
    prisma.giftCampaign.updateMany.mockResolvedValue({ count: 2 });
    const res = await service.runOnce();
    expect(res.completedCampaigns).toBe(2);
    expect(prisma.giftCampaign.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'dispatching',
        jobs: { none: { status: { in: ['pending', 'processing'] } } },
      },
      data: { status: 'completed' },
    });
  });

  it('does not start a timer under NODE_ENV=test even with the flag on', () => {
    process.env.QIFT_DISPATCH_WORKER_ENABLED = 'true';
    service.onModuleInit();
    expect(prisma.dispatchJob.findMany).not.toHaveBeenCalled();
    expect((service as unknown as { timer: unknown }).timer).toBeNull();
  });
});
