// InvoiceService — the corporate invoice money path (PR 4).
//
// AGENT MODEL (canonical): this issues Qift's SERVICE invoice. Qift is not
// the seller of the goods, so this invoice bills the Qift platform fee +
// VAT on the fee ONLY (agent_fee_only, see computeTax). The gift (goods)
// value is the merchant's revenue — recorded on the invoice's
// subtotalAmount as facilitated / pass-through value, never as Qift
// revenue, and excluded from Qift's VAT base and total. The separate
// merchant (goods) invoice and the combined Campaign Billing Summary are
// later PRs; this PR does not create them.
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
// the company receivable owed to Qift for its service invoice
// (totalAmount = fee + VAT on the fee). It is best-effort: a ledger hiccup
// must never undo an issued invoice. The goods-side collection / merchant
// payable + revenue recognition is deferred to the settlement PR.
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
import { computeTax } from '../fees/tax-engine';
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
    const snapshot =
      (option?.approvalSnapshot as ApprovalSnapshot | null) ?? null;
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
    // Freeze the Saudi VAT snapshot (server-side rule) onto the invoice.
    // Agent model: tax.taxableAmount / tax.totalAmount cover the Qift fee
    // only; tax.facilitatedValue is the goods subtotal (merchant's), which
    // is recorded but excluded from Qift's VAT and total.
    const tax = computeTax({
      subtotalAmount: amounts.subtotalAmount,
      platformFeeAmount: amounts.platformFeeAmount,
    });
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
          // Tax snapshot (Saudi VAT, agent model) — frozen for correctness.
          taxableAmount: tax.taxableAmount,
          vatRate: tax.vatRate,
          vatAmount: tax.vatAmount,
          totalBeforeVat: tax.totalBeforeVat,
          pricesIncludeVat: tax.pricesIncludeVat,
          taxTreatment: tax.taxTreatment,
          taxSnapshot: tax.taxSnapshot,
          // Qift service-invoice total the company owes Qift (agent model):
          // platform fee + VAT on the fee. The goods subtotal is NOT here.
          totalAmount: tax.totalAmount,
          // Accounting export not wired yet — explicit default.
          accountingExportStatus: 'not_exported',
          issuedAt: now,
          // Non-PII line context only. facilitatedValue = the goods
          // subtotal Qift facilitates on the merchant's behalf (merchant
          // revenue, not Qift's) — recorded for the future merchant invoice
          // + Campaign Billing Summary.
          metadata: {
            productName: snapshot.productName ?? null,
            storeName: snapshot.storeName ?? null,
            feePolicyVersion: FEE_POLICY_VERSION,
            facilitatedValue: tax.facilitatedValue,
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
  // Records the company receivable for Qift's SERVICE invoice: company
  // owes Qift totalAmount (agent model = platform fee + VAT on the fee).
  // direction 'credit' = amount owed TO Qift (Qift's favour). The goods
  // value is the merchant's (facilitated pass-through) and is NOT part of
  // this receivable; the goods-side settlement is deferred to a later PR.
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
