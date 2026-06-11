// ClaimExportService — ops-gated claim-link export (Corporate
// Foundation PR 7b).
//
// The manual-share model's missing piece: claim tokens are hashed at
// rest and the manual provider stores nothing, so the raw claim URL
// exists only transiently inside the dispatch worker. This export
// RE-MINTS each dispatched job's claim through ClaimMintService —
// which ROTATES the token on a pending claim — and hands ops the
// distribution list.
//
// Consequences, by design:
//   * EXPORT IS THE DISTRIBUTION EVENT. Any previously exported (or
//     worker-minted) link for a pending claim DIES when a new export
//     runs. Don't export twice after handing links over.
//   * Finalized claims (claimed / declined / mismatch / expired) are
//     REFUSED by the mint and reported as skipped — a recipient who
//     already acted is never disturbed, and a claimed gift's link is
//     never resurrected.
//   * The payload is { contactName, channel, claimUrl } ONLY. No
//     channel values, no addresses — ClaimAddress stays write-only;
//     this service never touches it.
//
// Every export writes an audit row (counts, never URLs): handing out
// claim links is a sensitive bulk action and must be attributable.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ClaimMintService } from './claim-mint.service';

// Matches the campaign recipient cap — one export covers any
// pilot-scale wave in a single call.
const MAX_EXPORT_JOBS = 1000;

export type ExportedClaimLink = {
  contactName: string;
  channel: 'phone' | 'email';
  claimUrl: string;
};

@Injectable()
export class ClaimExportService {
  constructor(
    private prisma: PrismaService,
    private claimMint: ClaimMintService,
    private audit: AuditService,
  ) {}

  async exportCampaignClaimLinks(
    actorUserId: string,
    orgId: string,
    campaignId: string,
  ) {
    // Tenant isolation: campaign keyed (id, orgId) — another org's
    // campaign id reads as missing even on the ops plane.
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { id: true, name: true, status: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');

    const jobs = await this.prisma.dispatchJob.findMany({
      where: { campaignId, status: 'dispatched' },
      select: { id: true, contactId: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_EXPORT_JOBS,
    });

    const links: ExportedClaimLink[] = [];
    let skippedFinalized = 0;
    let skippedUnreachable = 0;

    for (const job of jobs) {
      const minted = await this.claimMint.mintForJob({
        jobId: job.id,
        campaignId,
        contactId: job.contactId,
      });
      if (!minted.ok) {
        if (minted.error === 'claim_already_finalized') skippedFinalized += 1;
        else skippedUnreachable += 1;
        continue;
      }
      // Mint succeeded ⇒ the contact exists with a live channel.
      // Only the NAME and the channel TYPE leave this service — the
      // channel value stays server-side.
      const contact = await this.prisma.corporateContact.findUnique({
        where: { id: job.contactId },
        select: { fullName: true, phone: true },
      });
      links.push({
        contactName: contact?.fullName ?? '—',
        channel: contact?.phone ? 'phone' : 'email',
        claimUrl: minted.claimUrl,
      });
    }

    // Counts only — a claim URL in the audit log would defeat the
    // hash-at-rest posture.
    await this.audit.record({
      actorUserId,
      actorType: 'admin',
      action: 'admin.org.claim_links.export',
      targetType: 'organization',
      targetId: orgId,
      metadata: {
        campaignId,
        exported: links.length,
        skippedFinalized,
        skippedUnreachable,
      },
    });

    return {
      campaign: { id: campaign.id, name: campaign.name },
      exported: links.length,
      skippedFinalized,
      skippedUnreachable,
      links,
    };
  }
}
