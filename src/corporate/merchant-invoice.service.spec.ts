import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MerchantInvoiceService } from './merchant-invoice.service';

const ORG = 'org-1';
const CAMPAIGN = 'camp-1';
const STORE = 'store-1';
const ACTOR = 'approver-1';

// snapshot the approval froze: 500 SAR gift, 10 recipients, store-1.
const SNAPSHOT = {
  price: 500,
  productId: 'prod-1',
  productName: 'Bouquet',
  storeId: STORE,
  storeName: 'Rosary',
};

function build(
  opts: {
    existing?: unknown;
    status?: string | null;
    snapshot?: unknown;
    recipientCount?: number;
    productStoreId?: string | null;
  } = {},
) {
  const merchantInvoice = {
    findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'minv-1', ...data }),
      ),
  };
  const giftCampaign = {
    findFirst: jest
      .fn()
      .mockResolvedValue(
        opts.status === undefined
          ? { id: CAMPAIGN, status: 'approved' }
          : opts.status === null
            ? null
            : { id: CAMPAIGN, status: opts.status },
      ),
  };
  const campaignGiftOption = {
    findFirst: jest.fn().mockResolvedValue({
      productId: 'prod-1',
      approvalSnapshot: 'snapshot' in opts ? opts.snapshot : SNAPSHOT,
    }),
  };
  const campaignRecipient = {
    count: jest.fn().mockResolvedValue(opts.recipientCount ?? 10),
  };
  const product = {
    findUnique: jest
      .fn()
      .mockResolvedValue(
        opts.productStoreId === null
          ? null
          : { storeId: opts.productStoreId ?? STORE },
      ),
  };
  const prisma = {
    merchantInvoice,
    giftCampaign,
    campaignGiftOption,
    campaignRecipient,
    product,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const ledger = { record: jest.fn().mockResolvedValue({ id: 'ledger-1' }) };
  const service = new MerchantInvoiceService(
    prisma as never,
    audit as never,
    ledger as never,
  );
  return { service, prisma, audit, ledger };
}

const createdData = (prisma: ReturnType<typeof build>['prisma']) =>
  prisma.merchantInvoice.create.mock.calls[0][0].data as Record<
    string,
    unknown
  >;

describe('MerchantInvoiceService.ensureMerchantInvoiceForCampaign', () => {
  it('issues the goods invoice from the approval snapshot with correct amounts', async () => {
    const { service, prisma } = build();
    const inv = await service.ensureMerchantInvoiceForCampaign(
      ORG,
      CAMPAIGN,
      ACTOR,
    );
    const d = createdData(prisma);
    expect(d).toMatchObject({
      storeId: STORE,
      orgId: ORG,
      campaignId: CAMPAIGN,
      status: 'issued',
      currency: 'SAR',
      recipientCount: 10,
      unitAmount: 500,
      // The merchant's goods sale: 500 * 10 = 5000; VAT is the
      // MERCHANT's output VAT on the goods (agent model).
      goodsSubtotalAmount: 5000,
      vatRate: 0.15,
      vatAmount: 750,
      pricesIncludeVat: false,
      taxTreatment: 'merchant_goods_standard',
      // Goods total the company owes the MERCHANT (VAT-inclusive).
      totalAmount: 5750,
    });
    expect(d.issuedAt).toBeInstanceOf(Date);
    expect(inv).toMatchObject({ id: 'minv-1', status: 'issued' });
  });

  it('VAT on goods is the merchant leg — the Qift service invoice stays fee-only', async () => {
    const { service, prisma } = build();
    await service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    // Goods VAT (750 on 5000) lives HERE, on the merchant invoice…
    expect(d.vatAmount).toBe(750);
    expect(d.totalAmount).toBe(5750);
    // …and is far larger than Qift's fee-leg VAT (22.5 on the 150 fee,
    // pinned in invoice.service.spec.ts). Nothing here is Qift revenue.
    const snap = d.taxSnapshot as Record<string, unknown>;
    expect(snap.taxTreatment).toBe('merchant_goods_standard');
    expect(snap.taxableBase).toBe(5000);
    expect(String(snap.notes)).toMatch(/not Qift revenue/i);
  });

  it('freezes the merchant goods tax snapshot', async () => {
    const { service, prisma } = build();
    await service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    expect(d.taxSnapshot).toMatchObject({
      ruleVersion: 'sa-vat-agent-v1',
      vatRate: 0.15,
      taxTreatment: 'merchant_goods_standard',
      pricesIncludeVat: false,
      taxableBase: 5000,
      vatAmount: 750,
    });
  });

  it('posts a MERCHANT_GOODS_INVOICED ledger entry (pass-through, not Qift revenue)', async () => {
    const { service, ledger } = build();
    await service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][0]).toMatchObject({
      eventType: 'merchant.invoice.issued',
      reasonCode: 'MERCHANT_GOODS_INVOICED',
      amount: 5750, // goods total (VAT-inclusive), owed to the merchant
      direction: 'credit',
      counterpartyType: 'company',
      campaignId: CAMPAIGN,
      orgId: ORG,
      storeId: STORE,
      metadata: expect.objectContaining({ passThrough: true }),
    });
  });

  it('is idempotent — returns the existing invoice, no second create', async () => {
    const { service, prisma, ledger } = build({
      existing: { id: 'minv-1', campaignId: CAMPAIGN, storeId: STORE },
    });
    const inv = await service.ensureMerchantInvoiceForCampaign(
      ORG,
      CAMPAIGN,
      ACTOR,
    );
    expect(inv).toMatchObject({ id: 'minv-1' });
    expect(prisma.merchantInvoice.create).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('treats a racing P2002 as already-issued (one invoice per campaign/store)', async () => {
    const { service, prisma } = build();
    prisma.merchantInvoice.findFirst
      .mockResolvedValueOnce(null) // fast-path miss
      .mockResolvedValueOnce({ id: 'minv-raced', campaignId: CAMPAIGN }); // racer's row
    prisma.merchantInvoice.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    const inv = await service.ensureMerchantInvoiceForCampaign(
      ORG,
      CAMPAIGN,
      ACTOR,
    );
    expect(inv).toMatchObject({ id: 'minv-raced' });
  });

  it('falls back to the product row for storeId when an older snapshot lacks it', async () => {
    const { service, prisma } = build({
      snapshot: { price: 500, productName: 'Bouquet', storeName: 'Rosary' },
    });
    await service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(prisma.product.findUnique).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      select: { storeId: true },
    });
    expect(createdData(prisma).storeId).toBe(STORE);
  });

  it('cannot invoice when no storeId is resolvable', async () => {
    const { service } = build({
      snapshot: { price: 500, productName: 'Bouquet' },
      productStoreId: null,
    });
    await expect(
      service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toThrow('campaign_no_store');
  });

  it('metadata carries no employee identity / address / phone', async () => {
    const { service, prisma } = build({
      // even if the snapshot carried extra fields, the service must not copy PII
      snapshot: {
        price: 500,
        productId: 'prod-1',
        productName: 'Bouquet',
        storeId: STORE,
        storeName: 'Rosary',
        recipientName: 'Sara',
        recipientPhone: '+966500000000',
        address: 'secret',
      },
    });
    await service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    const meta = d.metadata as Record<string, unknown>;
    expect(meta).toEqual({
      productName: 'Bouquet',
      storeName: 'Rosary',
      issuedOnBehalfByQift: true,
    });
    // The tax snapshot must be PII-free too.
    const flat = JSON.stringify({
      metadata: meta,
      taxSnapshot: d.taxSnapshot,
    }).toLowerCase();
    for (const banned of [
      'sara',
      'recipientname',
      'phone',
      '+96650',
      'secret',
      'street',
    ]) {
      expect(flat).not.toContain(banned.toLowerCase());
    }
  });

  it('a ledger failure never blocks issuance (best-effort)', async () => {
    const { service, ledger } = build();
    ledger.record.mockRejectedValue(new Error('ledger db down'));
    const inv = await service.ensureMerchantInvoiceForCampaign(
      ORG,
      CAMPAIGN,
      ACTOR,
    );
    expect(inv).toMatchObject({ id: 'minv-1', status: 'issued' }); // invoice stands
  });

  it('cannot invoice a campaign that is not approved', async () => {
    const { service } = build({ status: 'pending_approval' });
    await expect(
      service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot invoice a campaign with no approval snapshot', async () => {
    const { service } = build({ snapshot: null });
    await expect(
      service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot invoice a campaign with zero recipients', async () => {
    const { service } = build({ recipientCount: 0 });
    await expect(
      service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when the campaign does not exist under the org', async () => {
    const { service } = build({ status: null });
    await expect(
      service.ensureMerchantInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MerchantInvoiceService.getMerchantInvoiceForCampaign', () => {
  it('reads tenant-scoped and returns null before issuance', async () => {
    const { service, prisma } = build();
    prisma.merchantInvoice.findFirst.mockResolvedValue(null);
    const inv = await service.getMerchantInvoiceForCampaign(ORG, CAMPAIGN);
    expect(inv).toBeNull();
    expect(prisma.merchantInvoice.findFirst).toHaveBeenCalledWith({
      where: { campaignId: CAMPAIGN, orgId: ORG },
    });
  });
});
