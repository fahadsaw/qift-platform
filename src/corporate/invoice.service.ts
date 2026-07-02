// InvoiceService — the corporate invoice money path (PR 4).
//
// Issues one CorporateInvoice per approved campaign, frozen from the
// campaign's approval snapshot. Manual / offline settlement only: no live
// PSP, no ZATCA XML, no merchant settlement, no refunds here.
//
// IDEMPOTENCY: CorporateInvoice.@@unique([campaignId]) is the anchor —
// exactly one invoice per campaign. ensureInvoiceForCampaign returns the
// existing invoice if present and treats a racing P2002 as already-issued,
// so a repeated approval/dispatch never duplicates.
//
// LEDGER: on issuance we post ONE minimal FinancialLedgerService entry —
// the company receivable (company owes Qift totalAmount). It is
// best-effort: a ledger hiccup must never undo an issued invoice. The
// payment-time allocation (merchant payable + revenue recognition) is
// deferred to the settlement PR.
//
// PRIVACY: no employee identity / address / phone / claim choice is ever
// written to the invoice or its ledger entry.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FinancialLedgerService } from '../financial/financial-ledger.service';
import { FEE_POLICY_VERSION } from '../fees/fee-engine';
import { computeInvoiceAmounts } from './invoice-amounts';

// The subset of the approval snapshot we read. Only non-PII fields.
type ApprovalSnapshot = {
  price?: number;
  productName?: string;
  storeName?: string;
};

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
  ) {}

  // Create (or return the existing) invoice for an APPROVED campaign.
  // Source of truth = the campaign's frozen approval snapshot.
  async ensureInvoiceForCampaign(
    orgId: string,
    campaignId: string,
    actorUserId: string | null,
  ) {
    // Idempotent fast-path.
    const existing = await this.prisma.corporateInvoice.findUnique({
      where: { campaignId },
    });
    if (existing) return existing;

    // The campaign must exist under this org and be approved.
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { id: true, status: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');
    if (campaign.status !== 'approved') {
      throw new BadRequestException('campaign_not_approved');
    }

    // The frozen snapshot is the source of truth for the price. A
    // campaign with no approval snapshot cannot be invoiced.
    const option = await this.prisma.campaignGiftOption.findFirst({
      where: { campaignId },
      select: { approvalSnapshot: true },
    });
    const snapshot = (option?.approvalSnapshot as ApprovalSnapshot | null) ?? null;
    if (!snapshot || typeof snapshot.price !== 'number') {
      throw new BadRequestException('campaign_no_snapshot');
    }

    const recipientCount = await this.prisma.campaignRecipient.count({
      where: { campaignId },
    });
    if (recipientCount <= 0) {
      throw new BadRequestException('campaign_recipients_required');
    }

    const amounts = computeInvoiceAmounts(snapshot.price, recipientCount);
    const now = new Date();

    try {
      const invoice = await this.prisma.corporateInvoice.create({
        data: {
          orgId,
          campaignId,
          status: 'issued',
          currency: 'SAR',
          recipientCount,
          unitAmount: amounts.unitAmount,
          subtotalAmount: amounts.subtotalAmount,
          platformFeeAmount: amounts.platformFeeAmount,
          totalAmount: amounts.totalAmount,
          issuedAt: now,
          // Non-PII line context only.
          metadata: {
            productName: snapshot.productName ?? null,
            storeName: snapshot.storeName ?? null,
            feePolicyVersion: FEE_POLICY_VERSION,
          },
        },
      });

      await this.recordReceivableLedger(invoice, actorUserId);

      await this.audit.record({
        actorUserId,
        actorType: actorUserId ? 'user' : 'system',
        action: 'org.invoice.issued',
        targetType: 'organization',
        targetId: orgId,
        metadata: {
          campaignId,
          invoiceId: invoice.id,
          totalAmount: invoice.totalAmount,
        },
      });

      return invoice;
    } catch (err) {
      // A racing caller already issued it — idempotent success.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.corporateInvoice.findUnique({
          where: { campaignId },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  // Read the invoice for a campaign, tenant-scoped. Returns null if not
  // yet issued. No side effects.
  async getInvoiceForCampaign(orgId: string, campaignId: string) {
    return this.prisma.corporateInvoice.findFirst({
      where: { campaignId, orgId },
    });
  }

  // Post-issuance ledger write — best-effort, never blocks issuance.
  // Records the company receivable: company owes Qift the invoice total.
  // direction 'credit' = amount owed TO Qift (Qift's favour). The
  // payment/settlement allocation is deferred to the settlement PR.
  private async recordReceivableLedger(
    invoice: {
      id: string;
      orgId: string;
      campaignId: string;
      totalAmount: number;
      currency: string;
      recipientCount: number;
    },
    actorUserId: string | null,
  ) {
    try {
      await this.ledger.record({
        eventType: 'corporate.invoice.issued',
        reasonCode: 'CORPORATE_RECEIVABLE',
        actorType: actorUserId ? 'user' : 'system',
        actorId: actorUserId,
        amount: invoice.totalAmount,
        currency: invoice.currency,
        direction: 'credit',
        counterpartyType: 'company',
        campaignId: invoice.campaignId,
        orgId: invoice.orgId,
        metadata: {
          invoiceId: invoice.id,
          recipientCount: invoice.recipientCount,
          feePolicyVersion: FEE_POLICY_VERSION,
        },
      });
    } catch (err) {
      this.logger.error(
        `[ledger-failed] invoice=${invoice.id} campaign=${invoice.campaignId} — ` +
          `invoice stands; receivable ledger is retryable. error=` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
