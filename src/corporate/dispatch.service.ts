// DispatchService — org-facing dispatch trigger + status reads
// (Corporate Foundation PR 4; Corporate Core v2 §5).
//
// Dispatch is the EXECUTION of an already-approved decision, so it
// is an admin-seat action (the maker–checker gate sits at approval,
// not here). The approved → dispatching flip is a conditional
// updateMany: two admins racing the button produce exactly one
// dispatch; the loser sees a conflict.

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class DispatchService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // Flip approved → dispatching and enqueue one DispatchJob per
  // recipient, atomically. idempotencyKey (campaignId:contactId) +
  // skipDuplicates make job creation replay-safe.
  async dispatchCampaign(
    actorUserId: string,
    orgId: string,
    campaignId: string,
  ) {
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { id: true, referenceNumber: true, status: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');
    if (campaign.status !== 'approved') {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: 'campaign_not_dispatchable',
          message: 'Only approved campaigns can be dispatched',
        },
        HttpStatus.CONFLICT,
      );
    }

    const recipients = await this.prisma.campaignRecipient.findMany({
      where: { campaignId },
      select: { contactId: true },
    });
    if (recipients.length === 0) {
      // Unreachable through the normal flow (submit requires
      // recipients) — defensive against direct data edits.
      throw new BadRequestException('campaign_recipients_required');
    }

    const enqueued = await this.prisma.$transaction(async (tx) => {
      const flip = await tx.giftCampaign.updateMany({
        where: { id: campaignId, orgId, status: 'approved' },
        data: { status: 'dispatching' },
      });
      if (flip.count === 0) {
        // Lost the race to another dispatcher.
        throw new HttpException(
          {
            statusCode: HttpStatus.CONFLICT,
            code: 'campaign_not_dispatchable',
            message: 'Campaign is no longer approved',
          },
          HttpStatus.CONFLICT,
        );
      }
      const jobs = await tx.dispatchJob.createMany({
        data: recipients.map((r) => ({
          campaignId,
          contactId: r.contactId,
          idempotencyKey: `${campaignId}:${r.contactId}`,
        })),
        skipDuplicates: true,
      });
      return jobs.count;
    });

    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.dispatch',
      targetType: 'organization',
      targetId: orgId,
      metadata: {
        campaignId,
        campaignReference: campaign.referenceNumber,
        jobs: enqueued,
      },
    });
    return { ok: true, jobs: enqueued };
  }

  // Operational job counts for one campaign. These are DISPATCH
  // counts (queue health), not participation outcomes — the F7
  // non-participation collapse applies to claim outcomes (PR 5+),
  // which are deliberately not represented here.
  async getDispatchStatus(orgId: string, campaignId: string) {
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { id: true, status: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');

    const grouped = await this.prisma.dispatchJob.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });
    const jobs: Record<string, number> = {};
    for (const g of grouped) {
      jobs[g.status] = g._count._all;
    }
    return { campaignStatus: campaign.status, jobs };
  }
}
