// ReportService — campaign funnel counters (Corporate Foundation
// PR 6; Corporate Core v2 §8).
//
// THE REPORTING PRIVACY MODEL, in one place:
//
//   1. The ORG sees AGGREGATE COUNTS ONLY. No per-recipient claim
//      status, no names, no channels, no addresses — ever. A
//      campaign report is a handful of integers.
//
//   2. F7 NON-PARTICIPATION COLLAPSE: declined, expired, mismatch,
//      revoked (and any future opted_out) are ONE undifferentiated
//      "did not participate" number on the org plane. Whether an
//      employee said no, ignored the link, or flagged a roster
//      error is not the employer's information. A gift must never
//      become a surveillance instrument.
//
//   3. The OPS plane (org.review permission) gets the full
//      per-status breakdown — ops needs `mismatch` to fix roster
//      errors with the org and `failed` jobs to unblock dispatch —
//      but still counts only, never identities.
//
// No schema here: these are pure reads over CampaignRecipient,
// DispatchJob, and ClaimableGift.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Terminal claim statuses the org-plane report collapses into the
// single didNotParticipate bucket (F7). `claimed` is the only
// terminal status reported on its own — delivery requires it, so it
// is inherently visible.
export const NON_PARTICIPATION_STATUSES: readonly string[] = [
  'declined',
  'expired',
  'mismatch',
  'revoked',
];

const REPORT_CAMPAIGN_SELECT = {
  id: true,
  name: true,
  occasion: true,
  status: true,
  submittedAt: true,
  approvedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class ReportService {
  constructor(private prisma: PrismaService) {}

  private async countsFor(campaignId: string) {
    const [recipients, jobsByStatus, claimsByStatus] = await Promise.all([
      this.prisma.campaignRecipient.count({ where: { campaignId } }),
      this.prisma.dispatchJob.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { _all: true },
      }),
      this.prisma.claimableGift.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { _all: true },
      }),
    ]);
    const jobs: Record<string, number> = {};
    for (const g of jobsByStatus) jobs[g.status] = g._count._all;
    const claims: Record<string, number> = {};
    for (const g of claimsByStatus) claims[g.status] = g._count._all;
    return { recipients, jobs, claims };
  }

  // ── Org plane: aggregate funnel, F7-collapsed ─────────────────────
  //
  // Response shape is a CONTRACT pinned by tests — adding a key here
  // (a status breakdown, a recipient list, a name) is a privacy
  // change, not a feature.
  async orgCampaignReport(orgId: string, campaignId: string) {
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: REPORT_CAMPAIGN_SELECT,
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');

    const { recipients, jobs, claims } = await this.countsFor(campaignId);

    const issued = Object.values(claims).reduce((a, b) => a + b, 0);
    const claimed = claims.claimed ?? 0;
    const pending = claims.pending ?? 0;
    // Everything terminal that isn't claimed collapses (F7). Derived
    // by subtraction so an unanticipated future status can never
    // leak as its own number on the org plane.
    const didNotParticipate = issued - claimed - pending;

    return {
      campaign,
      recipients,
      // Queue totals, not outcomes: how many gift links exist /
      // are still being prepared. Failures are an ops concern and
      // deliberately fold into "not yet dispatched" here.
      dispatched: jobs.dispatched ?? 0,
      gifts: {
        issued,
        claimed,
        pending,
        didNotParticipate,
      },
    };
  }

  // ── Ops plane: full granularity (counts only, never identities) ──
  async adminCampaignReport(orgId: string, campaignId: string) {
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { ...REPORT_CAMPAIGN_SELECT, createdBy: true, approvedBy: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');

    const { recipients, jobs, claims } = await this.countsFor(campaignId);
    return { campaign, recipients, jobs, claims };
  }
}
