// CampaignService — GiftCampaign lifecycle (Corporate Foundation
// PR 3; Corporate Core v2 §4).
//
// State machine:
//
//   draft → pending_approval → approved → dispatching → completed
//     ↑            |                        (PR 4)       (PR 4)
//     └── changes_requested ←┘
//   draft / pending_approval / changes_requested / approved → cancelled
//
// Separation of duties: the campaign's CREATOR can never approve or
// review it — not even an owner. The route guard establishes the
// approver/owner role; the createdBy check here is the second,
// person-level lock (maker–checker).
//
// Snapshot-at-approval: the moment a campaign is approved, the gift
// option freezes a copy of the product + store identity into
// approvalSnapshot. Later product edits, price changes, or
// delistings never change what the org signed off on.
//
// Tenant scoping: orgId always comes from the OrgRoleGuard context.
// Every campaign read is keyed { id, orgId }, so a campaign id from
// another org is indistinguishable from a missing one even though
// the guard already proved seat membership (defense in depth).

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InvoiceService } from './invoice.service';

// States in which the campaign content (name, message, option,
// recipients) may still be edited.
const EDITABLE: ReadonlySet<string> = new Set(['draft', 'changes_requested']);

// States from which cancel is allowed. Terminal states (cancelled,
// completed) and in-flight dispatch (PR 4 owns its own pause/stop
// semantics) are excluded.
const CANCELLABLE: ReadonlySet<string> = new Set([
  'draft',
  'pending_approval',
  'changes_requested',
  'approved',
]);

// Recipient cap per campaign — pilot scale (Corporate Core v2:
// C1 ≈ hundreds; thousands is C2 scope).
export const MAX_CAMPAIGN_RECIPIENTS = 1000;

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  occasion: true,
  message: true,
  status: true,
  createdBy: true,
  submittedAt: true,
  approvedAt: true,
  reviewNote: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type CampaignDraftInput = {
  name?: string;
  occasion?: string;
  message?: string;
};

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private invoices: InvoiceService,
  ) {}

  // Load a campaign strictly inside the caller's org.
  private async loadCampaign(orgId: string, campaignId: string) {
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { id: true, status: true, createdBy: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');
    return campaign;
  }

  private assertEditable(status: string) {
    if (!EDITABLE.has(status)) {
      throw new BadRequestException('campaign_not_editable');
    }
  }

  // ── Drafting ─────────────────────────────────────────────────────

  async createCampaign(
    actorUserId: string,
    orgId: string,
    body: CampaignDraftInput,
  ) {
    const name = body.name?.trim();
    if (!name || name.length < 3) {
      throw new BadRequestException('campaign_name_required');
    }
    // Campaigns belong to vetted orgs only — same gate as the roster.
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { status: true },
    });
    if (!org) throw new NotFoundException('org_not_found');
    if (org.status !== 'approved') {
      throw new BadRequestException('org_not_approved');
    }
    const campaign = await this.prisma.giftCampaign.create({
      data: {
        orgId,
        name,
        occasion: body.occasion?.trim() || null,
        message: body.message?.trim() || null,
        createdBy: actorUserId,
      },
      select: CAMPAIGN_SELECT,
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.create',
      targetType: 'organization',
      targetId: orgId,
      metadata: { campaignId: campaign.id, name },
    });
    return campaign;
  }

  async updateCampaign(
    actorUserId: string,
    orgId: string,
    campaignId: string,
    body: CampaignDraftInput,
  ) {
    const campaign = await this.loadCampaign(orgId, campaignId);
    this.assertEditable(campaign.status);
    const data: Record<string, string | null> = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name.length < 3) {
        throw new BadRequestException('campaign_name_required');
      }
      data.name = name;
    }
    if (body.occasion !== undefined) data.occasion = body.occasion.trim() || null;
    if (body.message !== undefined) data.message = body.message.trim() || null;
    return this.prisma.giftCampaign.update({
      where: { id: campaignId },
      data,
      select: CAMPAIGN_SELECT,
    });
  }

  // Set THE gift option (one-gift-for-all MVP: choice-of-K is
  // modelled in the schema but not approved scope, so the service
  // replaces rather than appends). The product must be live and
  // available NOW to be selectable; it is snapshotted later, at
  // approval.
  async setGiftOption(
    actorUserId: string,
    orgId: string,
    campaignId: string,
    productId: unknown,
  ) {
    if (typeof productId !== 'string' || !productId) {
      throw new BadRequestException('product_id_required');
    }
    const campaign = await this.loadCampaign(orgId, campaignId);
    this.assertEditable(campaign.status);
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, isAvailable: true, stockStatus: true },
    });
    if (!product || !product.isAvailable || product.stockStatus !== 'in_stock') {
      throw new BadRequestException('product_unavailable');
    }
    await this.prisma.$transaction([
      this.prisma.campaignGiftOption.deleteMany({ where: { campaignId } }),
      this.prisma.campaignGiftOption.create({
        data: { campaignId, productId },
      }),
    ]);
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.set_option',
      targetType: 'organization',
      targetId: orgId,
      metadata: { campaignId, productId },
    });
    return { ok: true };
  }

  // Attach roster contacts. Only ACTIVE contacts of THIS org attach;
  // anything else (other org's ids, archived rows, unknown ids) is
  // reported as skipped — never an oracle for other tenants' data.
  async addRecipients(
    actorUserId: string,
    orgId: string,
    campaignId: string,
    contactIds: unknown,
  ) {
    if (
      !Array.isArray(contactIds) ||
      contactIds.length === 0 ||
      !contactIds.every((id) => typeof id === 'string')
    ) {
      throw new BadRequestException('contact_ids_required');
    }
    const campaign = await this.loadCampaign(orgId, campaignId);
    this.assertEditable(campaign.status);

    const unique = [...new Set(contactIds as string[])];
    const valid = await this.prisma.corporateContact.findMany({
      where: { id: { in: unique }, orgId, status: 'active' },
      select: { id: true },
    });
    const validIds = new Set(valid.map((c) => c.id));

    const current = await this.prisma.campaignRecipient.count({
      where: { campaignId },
    });
    if (current + validIds.size > MAX_CAMPAIGN_RECIPIENTS) {
      throw new BadRequestException('campaign_recipient_cap_exceeded');
    }

    const result = await this.prisma.campaignRecipient.createMany({
      data: [...validIds].map((contactId) => ({ campaignId, contactId })),
      skipDuplicates: true,
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.add_recipients',
      targetType: 'organization',
      targetId: orgId,
      metadata: {
        campaignId,
        added: result.count,
        skipped: unique.length - result.count,
      },
    });
    return { added: result.count, skipped: unique.length - result.count };
  }

  async removeRecipient(
    actorUserId: string,
    orgId: string,
    campaignId: string,
    recipientId: string,
  ) {
    const campaign = await this.loadCampaign(orgId, campaignId);
    this.assertEditable(campaign.status);
    const result = await this.prisma.campaignRecipient.deleteMany({
      where: { id: recipientId, campaignId },
    });
    if (result.count === 0) {
      throw new NotFoundException('recipient_not_found');
    }
    return { ok: true };
  }

  // ── Reads ────────────────────────────────────────────────────────

  // Any seat may list campaigns — counts only, no recipient PII.
  listCampaigns(orgId: string) {
    return this.prisma.giftCampaign.findMany({
      where: { orgId },
      select: {
        ...CAMPAIGN_SELECT,
        _count: { select: { recipients: true, options: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // Detail incl. option + recipient names — admin/approver surface
  // (the approver must see exactly what they're approving).
  async getCampaign(orgId: string, campaignId: string) {
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: {
        ...CAMPAIGN_SELECT,
        options: {
          select: {
            id: true,
            productId: true,
            approvalSnapshot: true,
            snapshotAt: true,
          },
        },
        recipients: {
          select: {
            id: true,
            contactId: true,
            contact: {
              select: { fullName: true, department: true, status: true },
            },
          },
          take: MAX_CAMPAIGN_RECIPIENTS,
        },
      },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');
    return campaign;
  }

  // ── State machine ────────────────────────────────────────────────

  async submitForApproval(
    actorUserId: string,
    orgId: string,
    campaignId: string,
  ) {
    const campaign = await this.loadCampaign(orgId, campaignId);
    this.assertEditable(campaign.status);
    const [optionCount, recipientCount] = await Promise.all([
      this.prisma.campaignGiftOption.count({ where: { campaignId } }),
      this.prisma.campaignRecipient.count({ where: { campaignId } }),
    ]);
    if (optionCount === 0) {
      throw new BadRequestException('campaign_option_required');
    }
    if (recipientCount === 0) {
      throw new BadRequestException('campaign_recipients_required');
    }
    const updated = await this.prisma.giftCampaign.update({
      where: { id: campaignId },
      data: {
        status: 'pending_approval',
        submittedAt: new Date(),
        reviewNote: null,
      },
      select: CAMPAIGN_SELECT,
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.submit',
      targetType: 'organization',
      targetId: orgId,
      metadata: { campaignId, recipients: recipientCount },
    });
    return updated;
  }

  // Approve — the SoD-locked transition. Freezes the gift option
  // snapshot in the same transaction as the status flip.
  async approveCampaign(actorUserId: string, orgId: string, campaignId: string) {
    const campaign = await this.loadCampaign(orgId, campaignId);
    if (campaign.status !== 'pending_approval') {
      throw new BadRequestException('campaign_not_pending');
    }
    // MAKER–CHECKER: the role guard already proved approver/owner;
    // this is the person-level lock. Nobody approves their own
    // campaign, owners included.
    if (campaign.createdBy === actorUserId) {
      throw new ForbiddenException('campaign_sod_creator_cannot_approve');
    }

    const option = await this.prisma.campaignGiftOption.findFirst({
      where: { campaignId },
      select: { id: true, productId: true },
    });
    if (!option) throw new BadRequestException('campaign_option_required');

    // The product must still be live at the moment of approval —
    // approving a stale draft must not resurrect a delisted gift.
    const product = await this.prisma.product.findUnique({
      where: { id: option.productId },
      select: {
        id: true,
        name: true,
        price: true,
        imageUrl: true,
        category: true,
        isAvailable: true,
        stockStatus: true,
        storeId: true,
        store: { select: { id: true, name: true, status: true } },
      },
    });
    if (
      !product ||
      !product.isAvailable ||
      product.stockStatus !== 'in_stock' ||
      product.store?.status !== 'approved'
    ) {
      throw new BadRequestException('product_unavailable');
    }

    const snapshot = {
      productId: product.id,
      productName: product.name,
      price: product.price,
      imageUrl: product.imageUrl,
      category: product.category,
      storeId: product.storeId,
      storeName: product.store.name,
    };
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.giftCampaign.update({
        where: { id: campaignId },
        data: { status: 'approved', approvedBy: actorUserId, approvedAt: now },
        select: CAMPAIGN_SELECT,
      }),
      this.prisma.campaignGiftOption.update({
        where: { id: option.id },
        data: { approvalSnapshot: snapshot, snapshotAt: now },
      }),
    ]);
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.approve',
      targetType: 'organization',
      targetId: orgId,
      metadata: { campaignId, productId: product.id },
    });

    // Approval IS the commercial commitment point: issue the corporate
    // invoice from the snapshot we just froze. Best-effort + idempotent —
    // a failure here must NOT undo an approval that already committed
    // (the invoice can be re-ensured), and the @@unique([campaignId])
    // anchor prevents duplicates on any retry.
    try {
      await this.invoices.ensureInvoiceForCampaign(orgId, campaignId, actorUserId);
    } catch (err) {
      this.logger.error(
        `[invoice-failed] campaign=${campaignId} approved but invoice not ` +
          `issued (retryable): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return updated;
  }

  // Send back for changes — same SoD lock as approve: reviewing your
  // own campaign is reviewing, whatever the verdict.
  async requestChanges(
    actorUserId: string,
    orgId: string,
    campaignId: string,
    note: unknown,
  ) {
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (!trimmed) {
      throw new BadRequestException('campaign_review_note_required');
    }
    const campaign = await this.loadCampaign(orgId, campaignId);
    if (campaign.status !== 'pending_approval') {
      throw new BadRequestException('campaign_not_pending');
    }
    if (campaign.createdBy === actorUserId) {
      throw new ForbiddenException('campaign_sod_creator_cannot_approve');
    }
    const updated = await this.prisma.giftCampaign.update({
      where: { id: campaignId },
      data: { status: 'changes_requested', reviewNote: trimmed },
      select: CAMPAIGN_SELECT,
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.request_changes',
      targetType: 'organization',
      targetId: orgId,
      metadata: { campaignId, note: trimmed },
    });
    return updated;
  }

  async cancelCampaign(actorUserId: string, orgId: string, campaignId: string) {
    const campaign = await this.loadCampaign(orgId, campaignId);
    if (!CANCELLABLE.has(campaign.status)) {
      throw new BadRequestException('campaign_not_cancellable');
    }
    const updated = await this.prisma.giftCampaign.update({
      where: { id: campaignId },
      data: {
        status: 'cancelled',
        cancelledBy: actorUserId,
        cancelledAt: new Date(),
      },
      select: CAMPAIGN_SELECT,
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.campaign.cancel',
      targetType: 'organization',
      targetId: orgId,
      metadata: { campaignId, fromStatus: campaign.status },
    });
    return updated;
  }
}
