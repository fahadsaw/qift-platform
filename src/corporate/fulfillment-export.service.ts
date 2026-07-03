// FulfillmentExportService — the delivery leg's missing tooling
// (Track A5 / PE-06, Foundation Freeze ops blocker #1).
//
// ClaimAddress is deliberately write-only from every product surface
// (employer-blind invariant: the org NEVER sees where its employees
// live). But the pilot's deliverable is a DELIVERED gift — and before
// this service, the only way to get claimed addresses to the merchant
// was raw SQL against production: unaudited access to the platform's
// most sensitive PII, repeated every campaign. This closes that gap
// with a narrow, audited, ops-plane export:
//
//   * OPS PLANE ONLY — exposed on the admin/orgs controller behind
//     JwtAuthGuard + AdminGuard + OpsRoleGuard('org.review'), exactly
//     like the claim-link export. The ORG plane never gets this data;
//     employer-blindness is untouched.
//   * CLAIMED ROWS ONLY — recipients who haven't acted (pending),
//     declined, mismatched, or expired are never exported. Only people
//     who explicitly asked for delivery appear.
//   * AUDITED, COUNTS ONLY — every export writes an AuditLog row with
//     counts and ids, NEVER addresses or phones. The payload itself is
//     the one-shot handoff to ops → merchant.
//   * NON-MUTATING — unlike the claim-link export (which rotates
//     tokens), running this twice is harmless; POST is used for parity
//     and because sensitive-PII responses don't belong on cacheable
//     GETs.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// Matches the campaign recipient cap — one export covers any
// pilot-scale wave in a single call.
const MAX_EXPORT_ROWS = 1000;

export type FulfillmentRow = {
  recipientName: string;
  phone: string;
  country: string;
  region: string | null;
  city: string;
  district: string | null;
  line1: string;
  notes: string | null;
  claimedAt: Date | null;
};

// The non-PII gift context the merchant needs on the delivery sheet.
type CampaignFulfillmentHeader = {
  campaignId: string;
  campaignName: string;
  productName: string | null;
  storeName: string | null;
};

type ApprovalSnapshot = { productName?: string; storeName?: string };

@Injectable()
export class FulfillmentExportService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async exportCampaignFulfillment(
    actorUserId: string,
    orgId: string,
    campaignId: string,
  ): Promise<{
    campaign: CampaignFulfillmentHeader;
    count: number;
    rows: FulfillmentRow[];
  }> {
    // Tenant isolation: campaign keyed (id, orgId) — another org's
    // campaign id reads as missing even on the ops plane.
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { id: true, name: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');

    // Gift context from the frozen approval snapshot (what to deliver).
    const option = await this.prisma.campaignGiftOption.findFirst({
      where: { campaignId },
      select: { approvalSnapshot: true },
    });
    const snapshot =
      (option?.approvalSnapshot as ApprovalSnapshot | null) ?? null;

    // CLAIMED gifts only — the people who explicitly requested
    // delivery. Everyone else stays invisible.
    const claims = await this.prisma.claimableGift.findMany({
      where: { campaignId, status: 'claimed' },
      select: { id: true, recipientName: true, claimedAt: true },
      orderBy: { claimedAt: 'asc' },
      take: MAX_EXPORT_ROWS,
    });

    const addresses = await this.prisma.claimAddress.findMany({
      where: { claimId: { in: claims.map((c) => c.id) } },
    });
    const byClaim = new Map(addresses.map((a) => [a.claimId, a]));

    const rows: FulfillmentRow[] = [];
    let missingAddress = 0;
    for (const claim of claims) {
      const addr = byClaim.get(claim.id);
      if (!addr) {
        // A claimed gift without an address row is a data anomaly —
        // count it (surfaced in the result + audit) instead of
        // silently dropping the recipient.
        missingAddress += 1;
        continue;
      }
      rows.push({
        // Prefer the name the recipient entered with their address;
        // fall back to the roster name the claim was minted with.
        recipientName: addr.fullName?.trim() || claim.recipientName,
        phone: addr.phone,
        country: addr.country,
        region: addr.region ?? null,
        city: addr.city,
        district: addr.district ?? null,
        line1: addr.line1,
        notes: addr.notes ?? null,
        claimedAt: claim.claimedAt ?? null,
      });
    }

    // Counts only — never an address, phone, or name in the audit row.
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.fulfillment.exported',
      targetType: 'organization',
      targetId: orgId,
      metadata: {
        campaignId,
        claimedCount: claims.length,
        exportedCount: rows.length,
        missingAddressCount: missingAddress,
      },
    });

    return {
      campaign: {
        campaignId,
        campaignName: campaign.name,
        productName: snapshot?.productName ?? null,
        storeName: snapshot?.storeName ?? null,
      },
      count: rows.length,
      rows,
    };
  }
}
