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
import {
  buildMerchantSellerSnapshot,
  buildOrgBuyerSnapshot,
} from './party-snapshot';

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

    // FIN-1 — the merchant's VAT FACTS, read from the Store row at
    // issuance (the commitment point) and frozen into the snapshot:
    // whether the merchant is VAT-registered (charge VAT only if so),
    // its registration number, and its catalog-price convention. If
    // the Store row is somehow gone, fall to the conservative posture:
    // not registered → no VAT charged by accident.
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        vatRegistered: true,
        vatNumber: true,
        pricesIncludeVat: true,
        // FIN-2 — the merchant's legal identity, frozen into the
        // seller snapshot below.
        name: true,
        legalEntityName: true,
        commercialRegistrationNumber: true,
        taxCountry: true,
      },
    });
    const vatRegistered = store?.vatRegistered ?? false;
    const vatNumber = store?.vatNumber ?? null;
    const pricesIncludeVat = store?.pricesIncludeVat ?? true;
    if (vatRegistered && !vatNumber) {
      // Legal-completeness smell, not a blocker: registration is the
      // fact that governs charging; the number belongs on the document
      // and is enforced fully by the party snapshot in FIN-2.
      this.logger.warn(
        `[vat-facts] store=${storeId} is vatRegistered but has no ` +
          `vatNumber recorded — merchant invoice for campaign=` +
          `${campaignId} freezes vatNumber=null.`,
      );
    }

    // Reuse the same two-leg decomposition the Qift service invoice
    // uses; the goods leg is its subtotal. Then the merchant's VAT on
    // the goods (agent model: goods VAT is the merchant's, never
    // Qift's), governed by the merchant's own VAT facts.
    const amounts = computeInvoiceAmounts(snapshot.price, recipientCount);
    const goodsTax = computeMerchantGoodsTax({
      goodsSubtotalAmount: amounts.subtotalAmount,
      vatRegistered,
      vatNumber,
      pricesIncludeVat,
    });

    // FIN-2 — freeze buyer + seller legal identity at issuance. The
    // MERCHANT is the seller of record on this invoice; the company is
    // the buyer. FK-free table → the row carries its parties itself;
    // old invoices never re-read live Organization/Store rows.
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { legalName: true, crNumber: true, vatNumber: true },
    });
    const buyerSnapshot = buildOrgBuyerSnapshot(orgId, org);
    const sellerSnapshot = buildMerchantSellerSnapshot(storeId, store);
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
          // FIN-2 — frozen party identity (buyer = company, seller =
          // the merchant, legal seller of the goods).
          buyerSnapshot,
          sellerSnapshot,
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
