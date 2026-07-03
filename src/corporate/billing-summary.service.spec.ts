import { NotFoundException } from '@nestjs/common';
import { BillingSummaryService } from './billing-summary.service';

const ORG = 'org-1';
const CAMPAIGN = 'camp-1';
const STORE = 'store-1';

// The two persisted legs for the canonical worked example:
// 500 SAR gift x 10 recipients, 15/unit Qift fee.
const QIFT_INVOICE = {
  id: 'inv-1',
  status: 'issued',
  currency: 'SAR',
  issuedAt: new Date('2026-07-03T10:00:00Z'),
  recipientCount: 10,
  unitAmount: 500,
  subtotalAmount: 5000, // facilitated goods value (merchant's)
  platformFeeAmount: 150,
  vatAmount: 22.5, // Qift VAT on the fee only
  totalAmount: 172.5, // fee + VAT on fee
  metadata: { productName: 'Bouquet', storeName: 'Rosary' },
};

const MERCHANT_INVOICE = {
  id: 'minv-1',
  status: 'issued',
  currency: 'SAR',
  issuedAt: new Date('2026-07-03T10:00:01Z'),
  storeId: STORE,
  recipientCount: 10,
  unitAmount: 500,
  goodsSubtotalAmount: 5000,
  vatAmount: 750, // MERCHANT VAT on the goods
  totalAmount: 5750, // goods + merchant VAT
  metadata: { productName: 'Bouquet', storeName: 'Rosary' },
};

function build(
  opts: {
    campaign?: unknown;
    qift?: unknown;
    merchant?: unknown;
  } = {},
) {
  const prisma = {
    giftCampaign: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'campaign' in opts ? opts.campaign : { id: CAMPAIGN },
        ),
    },
  };
  const invoices = {
    getInvoiceForCampaign: jest
      .fn()
      .mockResolvedValue('qift' in opts ? opts.qift : QIFT_INVOICE),
  };
  const merchantInvoices = {
    getMerchantInvoiceForCampaign: jest
      .fn()
      .mockResolvedValue('merchant' in opts ? opts.merchant : MERCHANT_INVOICE),
  };
  const service = new BillingSummaryService(
    prisma as never,
    invoices as never,
    merchantInvoices as never,
  );
  return { service, prisma, invoices, merchantInvoices };
}

describe('BillingSummaryService.getCampaignBillingSummary', () => {
  it('combines the Qift service invoice + merchant goods invoice correctly', async () => {
    const { service } = build();
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s).toMatchObject({
      campaignId: CAMPAIGN,
      orgId: ORG,
      currency: 'SAR',
      commercialModel: 'agent',
      complete: true,
      missing: [],
      merchantInvoice: {
        leg: 'merchant_goods',
        seller: 'merchant',
        invoiceId: 'minv-1',
        status: 'issued',
        storeId: STORE,
        storeName: 'Rosary',
        goodsSubtotalAmount: 5000,
        vatAmount: 750,
        totalAmount: 5750,
      },
      qiftInvoice: {
        leg: 'qift_service',
        seller: 'qift',
        invoiceId: 'inv-1',
        status: 'issued',
        serviceFeeAmount: 150,
        vatAmount: 22.5,
        totalAmount: 172.5,
      },
    });
    expect(s.merchantInvoice!.issuedAt).toBeInstanceOf(Date);
    expect(s.qiftInvoice!.issuedAt).toBeInstanceOf(Date);
    expect(s.modelNote).toMatch(/agent, not a principal/i);
    expect(s.modelNote).toMatch(/legal seller/i);
  });

  it('grand total equals the sum of BOTH invoice totals', async () => {
    const { service } = build();
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s.grandTotalAmount).toBe(5922.5); // 5750 + 172.5
    expect(s.grandTotalAmount).toBe(
      s.merchantInvoice!.totalAmount + s.qiftInvoice!.totalAmount,
    );
  });

  it('the Qift leg stays fee-only — goods never appear as Qift amounts', async () => {
    const { service } = build();
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    // The Qift leg carries only the fee + VAT-on-fee…
    expect(s.qiftInvoice!.serviceFeeAmount).toBe(150);
    expect(s.qiftInvoice!.totalAmount).toBe(172.5);
    expect(s.qiftInvoice!.totalAmount).toBeLessThan(5000);
    // …and no goods field exists on it (the goods live on the merchant
    // leg only) — not even the invoice row's facilitated subtotal.
    expect(s.qiftInvoice).not.toHaveProperty('goodsSubtotalAmount');
    expect(s.qiftInvoice).not.toHaveProperty('subtotalAmount');
    expect(s.merchantInvoice).not.toHaveProperty('serviceFeeAmount');
  });

  it('the merchant leg stays goods-only — no fee field on it', async () => {
    const { service } = build();
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s.merchantInvoice!.goodsSubtotalAmount).toBe(5000);
    expect(s.merchantInvoice!.vatAmount).toBe(750);
    expect(s.merchantInvoice).not.toHaveProperty('platformFeeAmount');
    expect(s.merchantInvoice).not.toHaveProperty('serviceFeeAmount');
  });

  it('a missing merchant leg is explicit: null leg, no grand total, named in missing', async () => {
    const { service } = build({ merchant: null });
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s.merchantInvoice).toBeNull();
    expect(s.qiftInvoice).not.toBeNull();
    expect(s.grandTotalAmount).toBeNull(); // partial sum would lie
    expect(s.complete).toBe(false);
    expect(s.missing).toEqual(['merchant_invoice']);
  });

  it('both legs missing (pre-approval): both null, both named', async () => {
    const { service } = build({ qift: null, merchant: null });
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s.merchantInvoice).toBeNull();
    expect(s.qiftInvoice).toBeNull();
    expect(s.grandTotalAmount).toBeNull();
    expect(s.complete).toBe(false);
    expect(s.missing).toEqual(['merchant_invoice', 'qift_service_invoice']);
  });

  it('tenant isolation — a campaign outside the org is a 404, and both leg reads are org-scoped', async () => {
    const { service, invoices, merchantInvoices } = build({ campaign: null });
    await expect(
      service.getCampaignBillingSummary(ORG, CAMPAIGN),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Neither leg is fetched for a foreign campaign.
    expect(invoices.getInvoiceForCampaign).not.toHaveBeenCalled();
    expect(
      merchantInvoices.getMerchantInvoiceForCampaign,
    ).not.toHaveBeenCalled();

    // And when the campaign IS in-org, both leg getters receive orgId.
    const ok = build();
    await ok.service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(ok.invoices.getInvoiceForCampaign).toHaveBeenCalledWith(
      ORG,
      CAMPAIGN,
    );
    expect(
      ok.merchantInvoices.getMerchantInvoiceForCampaign,
    ).toHaveBeenCalledWith(ORG, CAMPAIGN);
  });

  it('exposes no PII — even when invoice metadata carries unexpected fields', async () => {
    // Simulate hostile/legacy rows whose metadata somehow carried PII:
    // the summary whitelists fields, so none of it may leak through.
    const { service } = build({
      qift: {
        ...QIFT_INVOICE,
        metadata: {
          productName: 'Bouquet',
          storeName: 'Rosary',
          recipientName: 'Sara',
          recipientPhone: '+966500000000',
          address: 'secret',
        },
      },
      merchant: {
        ...MERCHANT_INVOICE,
        metadata: {
          productName: 'Bouquet',
          storeName: 'Rosary',
          claimChoice: 'perfume',
          address: 'secret',
        },
      },
    });
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    const flat = JSON.stringify(s).toLowerCase();
    for (const banned of [
      'sara',
      'recipientname',
      'phone',
      '+96650',
      'secret',
      'address',
      'claimchoice',
      'street',
    ]) {
      expect(flat).not.toContain(banned.toLowerCase());
    }
    // The whitelisted, non-PII display fields still come through.
    expect(s.merchantInvoice!.storeName).toBe('Rosary');
  });

  it('FIN-3: converts Decimal invoice amounts to plain numbers', async () => {
    const dec = (n: number) => ({ toNumber: () => n });
    const { service } = build({
      qift: {
        ...QIFT_INVOICE,
        platformFeeAmount: dec(150),
        vatAmount: dec(22.5),
        totalAmount: dec(172.5),
      },
      merchant: {
        ...MERCHANT_INVOICE,
        goodsSubtotalAmount: dec(5000),
        vatAmount: dec(750),
        totalAmount: dec(5750),
      },
    });
    const s2 = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s2.qiftInvoice!.totalAmount).toBe(172.5);
    expect(s2.merchantInvoice!.goodsSubtotalAmount).toBe(5000);
    expect(s2.grandTotalAmount).toBe(5922.5);
    // The wire payload must carry numbers, never Decimal objects.
    expect(typeof s2.merchantInvoice!.vatAmount).toBe('number');
  });

  it('currency mismatch between legs omits the grand total (never a wrong sum)', async () => {
    const { service } = build({
      merchant: { ...MERCHANT_INVOICE, currency: 'KWD' },
    });
    const s2 = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s2.merchantInvoice).not.toBeNull();
    expect(s2.qiftInvoice).not.toBeNull();
    expect(s2.grandTotalAmount).toBeNull();
  });

  it('ignores a non-string storeName in metadata (whitelist is typed)', async () => {
    const { service } = build({
      merchant: { ...MERCHANT_INVOICE, metadata: { storeName: 42 } },
    });
    const s = await service.getCampaignBillingSummary(ORG, CAMPAIGN);
    expect(s.merchantInvoice!.storeName).toBeNull();
  });
});
