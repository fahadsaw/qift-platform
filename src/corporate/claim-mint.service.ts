// ClaimMintService — creates ClaimableGift rows for dispatch jobs
// (Corporate Foundation PR 5).
//
// Called by the dispatch worker while processing a job. Snapshots
// everything the claim page will ever need (recipient name, bound
// channel, org display name, campaign message, gift snapshot) so
// the claim survives roster purges and later campaign edits.
//
// Idempotent by jobId: re-processing a job ROTATES the token on the
// existing claim row (the old link dies, the new one works) instead
// of minting a duplicate gift.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateClaimToken, hashClaimToken } from './claim-token';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLAIM_TTL_DAYS = 30;

export type MintInput = {
  jobId: string;
  campaignId: string;
  contactId: string;
};

export type MintResult =
  | { ok: true; claimId: string; claimUrl: string }
  | { ok: false; error: string };

function claimTtlDays(): number {
  const n = Number(process.env.QIFT_CLAIM_TTL_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CLAIM_TTL_DAYS;
}

function claimBaseUrl(): string {
  return (process.env.QIFT_CLAIM_BASE_URL || 'https://www.qift.net').replace(
    /\/+$/,
    '',
  );
}

@Injectable()
export class ClaimMintService {
  constructor(private prisma: PrismaService) {}

  async mintForJob(input: MintInput): Promise<MintResult> {
    // A finalized claim must never have its token rotated — the
    // recipient already acted on it (claimed gifts are irrevocable).
    const existing = await this.prisma.claimableGift.findUnique({
      where: { jobId: input.jobId },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== 'pending') {
      return { ok: false, error: 'claim_already_finalized' };
    }

    const contact = await this.prisma.corporateContact.findUnique({
      where: { id: input.contactId },
      select: { fullName: true, phone: true, email: true },
    });
    if (!contact || (!contact.phone && !contact.email)) {
      return { ok: false, error: 'contact_unreachable' };
    }

    const campaign = await this.prisma.giftCampaign.findUnique({
      where: { id: input.campaignId },
      select: {
        message: true,
        org: { select: { displayName: true, displayNameAr: true } },
        options: {
          select: { approvalSnapshot: true },
          take: 1,
        },
      },
    });
    // One-option MVP: the single option must carry the snapshot
    // frozen at approval (JSON-null filtering is done here, not in
    // the query — Prisma Json where-clauses are not worth the trap).
    const snapshot = campaign?.options[0]?.approvalSnapshot;
    if (!campaign || !snapshot) {
      // No approved snapshot ⇒ this job should never have existed;
      // permanent failure, ops investigates.
      return { ok: false, error: 'campaign_snapshot_missing' };
    }

    const token = generateClaimToken();
    const tokenHash = hashClaimToken(token);
    const expiresAt = new Date(Date.now() + claimTtlDays() * DAY_MS);
    const data = {
      campaignId: input.campaignId,
      contactId: input.contactId,
      tokenHash,
      recipientName: contact.fullName,
      channel: contact.phone ? 'phone' : 'email',
      channelValue: contact.phone ?? contact.email!,
      orgDisplayName:
        campaign.org.displayNameAr || campaign.org.displayName,
      campaignMessage: campaign.message,
      giftSnapshot: snapshot,
      expiresAt,
    };

    const claim = existing
      ? await this.prisma.claimableGift.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        })
      : await this.prisma.claimableGift.create({
          data: { ...data, jobId: input.jobId },
          select: { id: true },
        });

    return {
      ok: true,
      claimId: claim.id,
      claimUrl: `${claimBaseUrl()}/claim/${token}`,
    };
  }
}
