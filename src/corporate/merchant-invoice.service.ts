// MerchantInvoiceService — the GOODS-leg invoice money path.
//
// AGENT MODEL (canonical): Qift is not the seller of the goods — the
// MERCHANT is. This service issues the merchant's goods invoice (the
// merchant's sale to the company: goods subtotal + the MERCHANT's VAT
// on the goods), generated and stored by Qift ON THE MERCHANT'S BEHALF
// (curated pilot merchants have no invoicing systems). Every amount
// here is merchant revenue, never Qift's — Qift's own charge lives on
// the fee-only Qift service invoice (InvoiceService). No settlement, no
// PSP, no ZATCA XML, no refunds here.
//
// COMMITMENT POINT: campaign approval — the same moment the Qift
// service invoice issues, frozen from the same approval snapshot, so
// the two legs of one campaign can never disagree about price or count.
//
// IDEMPOTENCY: MerchantInvoice.@@unique([campaignId, storeId]) is the
// anchor — one merchant invoice per campaign/store (the MVP campaign
// has exactly one store). ensureMerchantInvoiceForCampaign returns the
// existing invoice if present and treats a racing P2002 as
// already-issued, so a repeated approval never duplicates.
//
// LEDGER: on issuance we post ONE minimal FinancialLedgerService entry —
// MERCHANT_GOODS_INVOICED: the company owes the goods total on the
// merchant's invoice. direction 'credit' records money owed INTO the
// flow Qift orchestrates as disclosed collection agent; the metadata
// marks it pass-through — it is NOT Qift revenue (Qift revenue is only
// ever QIFT_SERVICE_FEE). The offsetting merchant-payable (Qift owes
// the merchant the collected goods money) posts at settlement, when
// money actually moves — deferred to the settlement PR. Best-effort: a
// ledger hiccup must never undo an issued invoice.
//
// PRIVACY: no employee identity / address / phone / claim choice is
// ever written to the invoice or its ledger entry.

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
import { computeMerchantGoodsTax } from '../fees/tax-engine';
import { computeInvoiceAmounts } from './invoice-amounts';

// The subset of the approval snapshot we read. Only non-PII fields.
type ApprovalSnapshot = {
  price?: number;
  productId?: string;
  productName?: string;
  storeId?: string;
  storeName?: string;
};

@Injectable()
export class MerchantInvoiceService {
  private readonly logger = new Logger(MerchantInvoiceService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
  ) {}

  // Create (or return the existing) merchant goods invoice for an
  // APPROVED campaign. Source of truth = the campaign's frozen approval
  // snapshot — the same snapshot the Qift service invoice reads.
  async ensureMerchantInvoiceForCampaign(
    orgId: string,
    campaignId: string,
    actorUserId: string | null,
  ) {
    // Idempotent fast-path. The MVP campaign has exactly one store, so
    // campaignId alone identifies the (campaign, store) pair.
    const existing = await this.prisma.merchantInvoice.findFirst({
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

    // The frozen snapshot is the source of truth for price + store. A
    // campaign with no approval snapshot cannot be invoiced.
    const option = await this.prisma.campaignGiftOption.findFirst({
      where: { campaignId },
      select: { productId: true, approvalSnapshot: true },
    });
    const snapshot =
      (option?.approvalSnapshot as ApprovalSnapshot | null) ?? null;
    if (!snapshot || typeof snapshot.price !== 'number') {
      throw new BadRequestException('campaign_no_snapshot');
    }

    // storeId: the snapshot has carried it since campaign approval
    // started freezing it. For any older snapshot without storeId,
    // fall back to the live product row (products never change store).
    let storeId = snapshot.storeId ?? null;
    if (!storeId && option?.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: option.productId },
        select: { storeId: true },
      });
      storeId = product?.storeId ?? null;
    }
    if (!storeId) {
      throw new BadRequestException('campaign_no_store');
    }

    const recipientCount = await this.prisma.campaignRecipient.count({
      where: { campaignId },
    });
    if (recipientCount <= 0) {
      throw new BadRequestException('campaign_recipients_required');
    }

    // Reuse the same two-leg decomposition the Qift service invoice
    // uses; the goods leg is its subtotal. Then the merchant's VAT on
    // the goods (agent model: goods VAT is the merchant's, never
    // Qift's).
    const amounts = computeInvoiceAmounts(snapshot.price, recipientCount);
    const goodsTax = computeMerchantGoodsTax({
      goodsSubtotalAmount: amounts.subtotalAmount,
    });
    const now = new Date();

    try {
      const invoice = await this.prisma.merchantInvoice.create({
        data: {
          storeId,
          orgId,
          campaignId,
          status: 'issued',
          currency: 'SAR',
          recipientCount,
          unitAmount: amounts.unitAmount,
          goodsSubtotalAmount: amounts.subtotalAmount,
          // Merchant VAT on the goods — frozen for historical
          // correctness.
          vatRate: goodsTax.vatRate,
          vatAmount: goodsTax.vatAmount,
          pricesIncludeVat: goodsTax.pricesIncludeVat,
          taxTreatment: goodsTax.taxTreatment,
          taxSnapshot: goodsTax.taxSnapshot,
          // Goods total the company owes the MERCHANT (VAT-inclusive).
          totalAmount: goodsTax.totalAmount,
          issuedAt: now,
          // Non-PII line context only. issuedOnBehalfByQift marks that
          // Qift generated this record for the merchant — the merchant
          // stays the legal seller/issuer of record.
          metadata: {
            productName: snapshot.productName ?? null,
            storeName: snapshot.storeName ?? null,
            issuedOnBehalfByQift: true,
          },
        },
      });

      await this.recordGoodsInvoicedLedger(invoice, actorUserId);

      await this.audit.record({
        actorUserId,
        actorType: actorUserId ? 'user' : 'system',
        action: 'org.merchant_invoice.issued',
        targetType: 'organization',
        targetId: orgId,
        metadata: {
          campaignId,
          invoiceId: invoice.id,
          storeId: invoice.storeId,
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
        const raced = await this.prisma.merchantInvoice.findFirst({
          where: { campaignId },
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  // Read the merchant invoice for a campaign, tenant-scoped. Returns
  // null if not yet issued. No side effects.
  async getMerchantInvoiceForCampaign(orgId: string, campaignId: string) {
    return this.prisma.merchantInvoice.findFirst({
      where: { campaignId, orgId },
    });
  }

  // Post-issuance ledger write — best-effort, never blocks issuance.
  // MERCHANT_GOODS_INVOICED: the company owes the goods total on the
  // MERCHANT's invoice. 'credit' = owed into the flow Qift orchestrates
  // as disclosed collection agent; metadata marks it pass-through (NOT
  // Qift revenue — that is only ever QIFT_SERVICE_FEE). The offsetting
  // MERCHANT_PAYABLE (Qift owes the merchant the collected goods money)
  // posts at settlement, when money actually moves.
  private async recordGoodsInvoicedLedger(
    invoice: {
      id: string;
      storeId: string;
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
        eventType: 'merchant.invoice.issued',
        reasonCode: 'MERCHANT_GOODS_INVOICED',
        actorType: actorUserId ? 'user' : 'system',
        actorId: actorUserId,
        amount: invoice.totalAmount,
        currency: invoice.currency,
        direction: 'credit',
        counterpartyType: 'company',
        campaignId: invoice.campaignId,
        orgId: invoice.orgId,
        storeId: invoice.storeId,
        metadata: {
          invoiceId: invoice.id,
          recipientCount: invoice.recipientCount,
          // Pass-through on the merchant's behalf — not Qift revenue.
          passThrough: true,
        },
      });
    } catch (err) {
      this.logger.error(
        `[ledger-failed] merchantInvoice=${invoice.id} campaign=${invoice.campaignId} — ` +
          `invoice stands; goods-invoiced ledger is retryable. error=` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
