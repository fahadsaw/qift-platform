import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InvoiceService } from './invoice.service';

const ORG = 'org-1';
const CAMPAIGN = 'camp-1';
const ACTOR = 'approver-1';

// snapshot the approval froze: 500 SAR gift, 10 recipients.
const SNAPSHOT = { price: 500, productName: 'Bouquet', storeName: 'Rosary' };

function build(
  opts: {
    existing?: unknown;
    status?: string | null;
    snapshot?: unknown;
    recipientCount?: number;
  } = {},
) {
  const corporateInvoice = {
    findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
    findFirst: jest.fn(),
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'inv-1', ...data }),
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
      approvalSnapshot: 'snapshot' in opts ? opts.snapshot : SNAPSHOT,
    }),
  };
  const campaignRecipient = {
    count: jest.fn().mockResolvedValue(opts.recipientCount ?? 10),
  };
  const prisma = {
    corporateInvoice,
    giftCampaign,
    campaignGiftOption,
    campaignRecipient,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const ledger = { record: jest.fn().mockResolvedValue({ id: 'ledger-1' }) };
  const service = new InvoiceService(
    prisma as never,
    audit as never,
    ledger as never,
  );
  return { service, prisma, audit, ledger };
}

const createdData = (prisma: ReturnType<typeof build>['prisma']) =>
  prisma.corporateInvoice.create.mock.calls[0][0].data as Record<
    string,
    unknown
  >;

describe('InvoiceService.ensureInvoiceForCampaign', () => {
  it('issues an invoice from the approval snapshot with correct amounts', async () => {
    const { service, prisma } = build();
    const inv = await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    expect(d).toMatchObject({
      orgId: ORG,
      campaignId: CAMPAIGN,
      status: 'issued',
      currency: 'SAR',
      recipientCount: 10,
      unitAmount: 500,
      // Goods value stays recorded (merchant's), but as facilitated
      // pass-through — NOT Qift taxable revenue.
      subtotalAmount: 5000,
      platformFeeAmount: 150,
      // Saudi VAT (agent_fee_only, exclusive): VAT on the 150 fee only.
      taxableAmount: 150,
      vatRate: 0.15,
      vatAmount: 22.5,
      totalBeforeVat: 150,
      pricesIncludeVat: false,
      taxTreatment: 'agent_fee_only',
      // Qift service invoice total = fee + VAT on fee (goods excluded).
      totalAmount: 172.5,
    });
    expect(d.issuedAt).toBeInstanceOf(Date);
    expect(inv).toMatchObject({ id: 'inv-1', status: 'issued' });
  });

  it('records the goods value as facilitated pass-through, not Qift revenue', async () => {
    const { service, prisma } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    // Goods subtotal is preserved on the invoice…
    expect(d.subtotalAmount).toBe(5000);
    // …but the Qift service total and VAT base exclude it entirely.
    expect(d.totalAmount).toBe(172.5);
    expect(d.taxableAmount).toBe(150);
    // …and it is labelled as facilitated value in the snapshot + metadata.
    expect((d.taxSnapshot as Record<string, unknown>).facilitatedValue).toBe(
      5000,
    );
    expect((d.metadata as Record<string, unknown>).facilitatedValue).toBe(5000);
  });

  it('freezes the tax snapshot + defaults accounting export to not_exported', async () => {
    const { service, prisma } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    expect(d.taxSnapshot).toMatchObject({
      ruleVersion: 'sa-vat-agent-v1',
      vatRate: 0.15,
      taxTreatment: 'agent_fee_only',
    });
    expect(d.accountingExportStatus).toBe('not_exported');
  });

  it('posts a company-receivable ledger entry for the Qift service total (fee + VAT)', async () => {
    const { service, ledger } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][0]).toMatchObject({
      reasonCode: 'CORPORATE_RECEIVABLE',
      amount: 172.5, // Qift service invoice: fee 150 + VAT 22.5 (goods excluded)
      direction: 'credit',
      counterpartyType: 'company',
      campaignId: CAMPAIGN,
      orgId: ORG,
    });
  });

  it('is idempotent — returns the existing invoice, no second create', async () => {
    const { service, prisma, ledger } = build({
      existing: { id: 'inv-1', campaignId: CAMPAIGN },
    });
    const inv = await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(inv).toMatchObject({ id: 'inv-1' });
    expect(prisma.corporateInvoice.create).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('treats a racing P2002 as already-issued', async () => {
    const { service, prisma } = build();
    prisma.corporateInvoice.findUnique
      .mockResolvedValueOnce(null) // fast-path miss
      .mockResolvedValueOnce({ id: 'inv-raced', campaignId: CAMPAIGN }); // racer's row
    prisma.corporateInvoice.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    const inv = await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(inv).toMatchObject({ id: 'inv-raced' });
  });

  it('metadata carries no employee identity / address / phone', async () => {
    const { service, prisma } = build({
      // even if the snapshot carried extra fields, the service must not copy PII
      snapshot: {
        price: 500,
        productName: 'Bouquet',
        storeName: 'Rosary',
        recipientName: 'Sara',
        recipientPhone: '+966500000000',
        address: 'secret',
      },
    });
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    const meta = d.metadata as Record<string, unknown>;
    expect(meta).toEqual({
      productName: 'Bouquet',
      storeName: 'Rosary',
      feePolicyVersion: expect.any(String),
      facilitatedValue: 5000, // goods pass-through (500 * 10 recipients), not PII
    });
    // The tax snapshot + accounting fields must be PII-free too.
    const flat = JSON.stringify({
      metadata: meta,
      taxSnapshot: d.taxSnapshot,
      externalAccountingProvider: d.externalAccountingProvider ?? null,
      externalAccountingInvoiceId: d.externalAccountingInvoiceId ?? null,
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
    const inv = await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(inv).toMatchObject({ id: 'inv-1', status: 'issued' }); // invoice stands
  });

  it('cannot invoice a campaign that is not approved', async () => {
    const { service } = build({ status: 'pending_approval' });
    await expect(
      service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot invoice a campaign with no approval snapshot', async () => {
    const { service } = build({ snapshot: null });
    await expect(
      service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot invoice a campaign with zero recipients', async () => {
    const { service } = build({ recipientCount: 0 });
    await expect(
      service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when the campaign does not exist under the org', async () => {
    const { service } = build({ status: null });
    await expect(
      service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
