// BillingSummaryService — the company-facing Campaign Billing Summary.
//
// A COMPUTED READ-MODEL, deliberately NOT a table: both legs already
// exist as persisted, snapshot-frozen invoices (CorporateInvoice = the
// Qift SERVICE leg, MerchantInvoice = the merchant GOODS leg), so a
// stored summary would only be denormalized duplication that can drift.
// This service recombines the two legs into the single commercial view
// the company sees. No settlement, no PSP, no ZATCA XML, no refunds.
//
// AGENT MODEL (canonical): Qift is an agent, not a principal. The
// MERCHANT is the legal seller of the goods — the goods subtotal and
// the VAT on the goods live on the merchant invoice, under the
// merchant's VAT registration. Qift bills ONLY its platform service
// fee (+ VAT on the fee) on the Qift service invoice. The grand total
// is what the company pays across BOTH invoices.
//
// PRIVACY: built exclusively from the two invoice rows, which are
// PII-free by construction. Fields are WHITELISTED below — invoice
// metadata is never spread wholesale into the response, so no employee
// identity / address / phone / claim choice can ever appear here.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';
import { MerchantInvoiceService } from './merchant-invoice.service';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The merchant GOODS leg — the merchant's sale to the company.
export type MerchantLegSummary = {
  leg: 'merchant_goods';
  seller: 'merchant';
  invoiceId: string;
  status: string;
  issuedAt: Date | null;
  storeId: string;
  storeName: string | null;
  goodsSubtotalAmount: number;
  vatAmount: number; // MERCHANT VAT on the goods
  totalAmount: number; // merchant invoice total (VAT-inclusive)
};

// The Qift SERVICE leg — Qift's platform fee.
export type QiftLegSummary = {
  leg: 'qift_service';
  seller: 'qift';
  invoiceId: string;
  status: string;
  issuedAt: Date | null;
  serviceFeeAmount: number;
  vatAmount: number; // Qift VAT on the service fee only
  totalAmount: number; // Qift invoice total (VAT-inclusive)
};

export type CampaignBillingSummary = {
  campaignId: string;
  orgId: string;
  currency: string;
  // Canonical commercial model, labelled explicitly so no consumer of
  // this payload can mistake the goods leg for Qift revenue.
  commercialModel: 'agent';
  modelNote: string;
  merchantInvoice: MerchantLegSummary | null;
  qiftInvoice: QiftLegSummary | null;
  // Sum of both invoice totals — what the company pays for the
  // campaign. Null until BOTH legs exist (a partial sum would read as
  // the full price).
  grandTotalAmount: number | null;
  // True when both legs are issued. `missing` names any absent leg so
  // a partial state is explicit, never silent.
  complete: boolean;
  missing: Array<'merchant_invoice' | 'qift_service_invoice'>;
};

const MODEL_NOTE =
  'Qift is an agent, not a principal. The merchant is the legal seller ' +
  'of the goods: the goods subtotal and its VAT belong to the merchant ' +
  '(goods invoice). Qift bills only its platform service fee and the ' +
  'VAT on that fee (service invoice). The grand total is payable across ' +
  'both invoices.';

@Injectable()
export class BillingSummaryService {
  constructor(
    private prisma: PrismaService,
    private invoices: InvoiceService,
    private merchantInvoices: MerchantInvoiceService,
  ) {}

  // Compute the billing summary for a campaign, tenant-scoped. Both
  // invoice reads go through the existing tenant-scoped getters, so
  // org isolation is enforced in exactly one place per leg.
  async getCampaignBillingSummary(
    orgId: string,
    campaignId: string,
  ): Promise<CampaignBillingSummary> {
    // The campaign itself must exist under this org — a summary for a
    // foreign/unknown campaign is a 404, not an empty payload.
    const campaign = await this.prisma.giftCampaign.findFirst({
      where: { id: campaignId, orgId },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException('campaign_not_found');

    const [qift, merchant] = await Promise.all([
      this.invoices.getInvoiceForCampaign(orgId, campaignId),
      this.merchantInvoices.getMerchantInvoiceForCampaign(orgId, campaignId),
    ]);

    // Whitelisted projections — never spread the invoice row or its
    // metadata wholesale (privacy invariant).
    const qiftLeg: QiftLegSummary | null = qift
      ? {
          leg: 'qift_service',
          seller: 'qift',
          invoiceId: qift.id,
          status: qift.status,
          issuedAt: qift.issuedAt ?? null,
          serviceFeeAmount: qift.platformFeeAmount,
          vatAmount: qift.vatAmount ?? 0,
          totalAmount: qift.totalAmount,
        }
      : null;

    const merchantMeta =
      (merchant?.metadata as { storeName?: string } | null) ?? null;
    const merchantLeg: MerchantLegSummary | null = merchant
      ? {
          leg: 'merchant_goods',
          seller: 'merchant',
          invoiceId: merchant.id,
          status: merchant.status,
          issuedAt: merchant.issuedAt ?? null,
          storeId: merchant.storeId,
          storeName:
            typeof merchantMeta?.storeName === 'string'
              ? merchantMeta.storeName
              : null,
          goodsSubtotalAmount: merchant.goodsSubtotalAmount,
          vatAmount: merchant.vatAmount,
          totalAmount: merchant.totalAmount,
        }
      : null;

    const missing: CampaignBillingSummary['missing'] = [];
    if (!merchantLeg) missing.push('merchant_invoice');
    if (!qiftLeg) missing.push('qift_service_invoice');

    return {
      campaignId,
      orgId,
      // Both legs are SAR today; prefer whichever leg exists so the
      // summary stays honest if currencies ever diverge per leg.
      currency: qift?.currency ?? merchant?.currency ?? 'SAR',
      commercialModel: 'agent',
      modelNote: MODEL_NOTE,
      merchantInvoice: merchantLeg,
      qiftInvoice: qiftLeg,
      grandTotalAmount:
        merchantLeg && qiftLeg
          ? round2(merchantLeg.totalAmount + qiftLeg.totalAmount)
          : null,
      complete: missing.length === 0,
      missing,
    };
  }
}
