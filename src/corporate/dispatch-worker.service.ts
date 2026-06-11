// DispatchWorkerService — processes the DispatchJob queue
// (Corporate Foundation PR 4; Corporate Core v2 §5).
//
// House worker pattern (GiftsAutoDefaultService): plain setInterval,
// test-env skip, boot kick, unref. Replica-safe by construction —
// each job is CLAIMED with a conditional updateMany
// (pending → processing); a lost race is a silent skip.
//
// Two activation controls:
//   QIFT_DISPATCH_WORKER_ENABLED='true'  — starts the timer
//                                          (DEFAULT OFF).
//   QIFT_DISPATCH_PAUSED='true'          — emergency brake: the
//                                          sweep short-circuits
//                                          without touching jobs,
//                                          re-checked every tick so
//                                          flipping it needs no
//                                          restart.
//
// Per job: read the contact's channel LIVE (phone preferred, email
// fallback — never persisted on the job), hand the delivery to the
// provider lane, then settle:
//   provider ok        → dispatched (+ processedAt)
//   provider error     → pending again while attempts < MAX, else
//                        failed
//   permanent error /
//   contact unreachable→ failed immediately (retries can't fix it)
//
// After each sweep, dispatching campaigns with no live jobs left
// (nothing pending/processing) flip to completed — failures included:
// a wave with 3 failed jobs is finished, and the failures stay
// visible in dispatch-status.

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DISPATCH_PROVIDER,
  type DispatchProvider,
} from './dispatch-provider';
import { ClaimMintService } from './claim-mint.service';

const SWEEP_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 25;
export const MAX_DISPATCH_ATTEMPTS = 3;

@Injectable()
export class DispatchWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchWorkerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    @Inject(DISPATCH_PROVIDER) private provider: DispatchProvider,
    private claimMint: ClaimMintService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.QIFT_DISPATCH_WORKER_ENABLED !== 'true') {
      this.logger.log(
        'Dispatch worker disabled (QIFT_DISPATCH_WORKER_ENABLED != true)',
      );
      return;
    }
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Public for tests + future ops trigger.
  async runOnce(): Promise<{
    processed: number;
    dispatched: number;
    failed: number;
    retried: number;
    completedCampaigns: number;
    paused: boolean;
  }> {
    if (process.env.QIFT_DISPATCH_PAUSED === 'true') {
      this.logger.warn('Dispatch sweep skipped: QIFT_DISPATCH_PAUSED=true');
      return {
        processed: 0,
        dispatched: 0,
        failed: 0,
        retried: 0,
        completedCampaigns: 0,
        paused: true,
      };
    }

    const batch = await this.prisma.dispatchJob.findMany({
      where: { status: 'pending' },
      select: {
        id: true,
        campaignId: true,
        contactId: true,
        attempts: true,
        claimRef: true,
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });

    let processed = 0;
    let dispatched = 0;
    let failed = 0;
    let retried = 0;

    for (const job of batch) {
      try {
        // Claim. Losing the race to a replica is a silent skip.
        const claim = await this.prisma.dispatchJob.updateMany({
          where: { id: job.id, status: 'pending' },
          data: { status: 'processing', attempts: { increment: 1 } },
        });
        if (claim.count === 0) continue;
        processed += 1;
        const attemptNo = job.attempts + 1;

        // Channel is read live and never written to the job row.
        const contact = await this.prisma.corporateContact.findUnique({
          where: { id: job.contactId },
          select: { phone: true, email: true },
        });
        const channel: 'phone' | 'email' | null = contact?.phone
          ? 'phone'
          : contact?.email
            ? 'email'
            : null;
        if (!contact || !channel) {
          // Purged or channel-less contact — no retry can fix this.
          failed += 1;
          await this.prisma.dispatchJob.updateMany({
            where: { id: job.id, status: 'processing' },
            data: { status: 'failed', lastError: 'contact_unreachable' },
          });
          continue;
        }

        // PR 5: mint (or rotate) the claim before delivery. A mint
        // failure on a finalized claim or a snapshotless campaign is
        // permanent; ops investigates via dispatch-status.
        const minted = await this.claimMint.mintForJob({
          jobId: job.id,
          campaignId: job.campaignId,
          contactId: job.contactId,
        });
        if (!minted.ok) {
          failed += 1;
          await this.prisma.dispatchJob.updateMany({
            where: { id: job.id, status: 'processing' },
            data: { status: 'failed', lastError: minted.error },
          });
          continue;
        }

        const result = await this.provider.deliver({
          jobId: job.id,
          campaignId: job.campaignId,
          contactId: job.contactId,
          channel,
          channelValue:
            channel === 'phone' ? contact.phone! : contact.email!,
          claimUrl: minted.claimUrl,
        });

        if (result.ok) {
          dispatched += 1;
          await this.prisma.dispatchJob.updateMany({
            where: { id: job.id, status: 'processing' },
            data: {
              status: 'dispatched',
              processedAt: new Date(),
              lastError: null,
              claimRef: minted.claimId,
            },
          });
        } else if (!result.permanent && attemptNo < MAX_DISPATCH_ATTEMPTS) {
          retried += 1;
          await this.prisma.dispatchJob.updateMany({
            where: { id: job.id, status: 'processing' },
            data: { status: 'pending', lastError: result.error },
          });
        } else {
          failed += 1;
          await this.prisma.dispatchJob.updateMany({
            where: { id: job.id, status: 'processing' },
            data: { status: 'failed', lastError: result.error },
          });
        }
      } catch (err) {
        // One bad job must not take the sweep down. The job stays
        // 'processing'; a future PR can add a stale-processing
        // reaper — at pilot scale ops watches dispatch-status.
        this.logger.warn(
          `Dispatch failed for job ${job.id}: ${(err as Error).message}`,
        );
      }
    }

    const completedCampaigns = await this.completeFinishedCampaigns();

    if (processed > 0 || completedCampaigns > 0) {
      this.logger.log(
        `Dispatch sweep: processed ${processed}, dispatched ${dispatched}, ` +
          `retried ${retried}, failed ${failed}, ` +
          `completed campaigns ${completedCampaigns}`,
      );
    }
    return {
      processed,
      dispatched,
      failed,
      retried,
      completedCampaigns,
      paused: false,
    };
  }

  // dispatching → completed once no live (pending/processing) jobs
  // remain. Failed jobs don't block completion; they stay visible in
  // the dispatch-status counts.
  private async completeFinishedCampaigns(): Promise<number> {
    const result = await this.prisma.giftCampaign.updateMany({
      where: {
        status: 'dispatching',
        jobs: { none: { status: { in: ['pending', 'processing'] } } },
      },
      data: { status: 'completed' },
    });
    return result.count;
  }
}
