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
    org?: unknown; // FIN-2 — Organization row (null = missing)
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
  const organization = {
    findUnique: jest.fn().mockResolvedValue(
      'org' in opts
        ? opts.org
        : {
            legalName: 'Alwadi Trading Co LLC',
            crNumber: '1010101010',
            vatNumber: '300000000000003',
          },
    ),
  };
  const prisma = {
    corporateInvoice,
    giftCampaign,
    campaignGiftOption,
    campaignRecipient,
    organization,
    // QC numbering (Track A.5): the sequence allocation runs inside
    // the same transaction as the create; the tx client IS this mock.
    $queryRaw: jest.fn().mockResolvedValue([{ lastValue: 1 }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordGuaranteed: jest.fn().mockResolvedValue(undefined),
  };
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
      ruleVersion: 'sa-vat-agent-v3',
      vatRate: 0.15,
      taxTreatment: 'agent_fee_only',
    });
    expect(d.accountingExportStatus).toBe('not_exported');
  });

  it('freezes buyer (company) + seller (Qift) party snapshots at issuance', async () => {
    const { service, prisma } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    expect(d.buyerSnapshot).toEqual({
      partyType: 'organization',
      orgId: ORG,
      legalName: 'Alwadi Trading Co LLC',
      crNumber: '1010101010',
      vatNumber: '300000000000003',
      country: 'SA',
    });
    // Seller on the SERVICE invoice is QIFT — env-configured legal
    // identity; unconfigured in the test env, recorded honestly.
    expect(d.sellerSnapshot).toMatchObject({
      partyType: 'qift',
      country: 'SA',
      configured: false,
    });
  });

  it('later org changes never alter an already-issued invoice snapshot', async () => {
    const { service, prisma } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const frozen = createdData(prisma).buyerSnapshot as Record<string, unknown>;
    // The company renames itself AFTER issuance…
    prisma.organization.findUnique.mockResolvedValue({
      legalName: 'Renamed Holdings',
      crNumber: '9999999999',
      vatNumber: '399999999999993',
    });
    // …the idempotent fast-path returns the EXISTING row; no update,
    // no re-snapshot, no second create.
    prisma.corporateInvoice.findUnique.mockResolvedValue({
      id: 'inv-1',
      buyerSnapshot: frozen,
    });
    const again = await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(prisma.corporateInvoice.create).toHaveBeenCalledTimes(1);
    expect(
      (again as { buyerSnapshot?: Record<string, unknown> }).buyerSnapshot,
    ).toEqual(frozen);
    expect(frozen.legalName).toBe('Alwadi Trading Co LLC'); // unchanged
  });

  it('a missing org row freezes nulls — identity is never invented', async () => {
    const { service, prisma } = build({ org: null });
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    expect(d.buyerSnapshot).toMatchObject({
      partyType: 'organization',
      orgId: ORG,
      legalName: null,
      crNumber: null,
      vatNumber: null,
    });
  });

  it('party snapshots carry no employee PII', async () => {
    const { service, prisma } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    const d = createdData(prisma);
    const flat = JSON.stringify({
      buyerSnapshot: d.buyerSnapshot,
      sellerSnapshot: d.sellerSnapshot,
    }).toLowerCase();
    for (const banned of [
      'recipientname',
      'phone',
      '+96650',
      'address',
      'claimchoice',
      'street',
    ]) {
      expect(flat).not.toContain(banned);
    }
  });

  it('posts a company-receivable ledger entry for the Qift service total (fee + VAT)', async () => {
    const { service, ledger } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][0]).toMatchObject({
      eventType: 'corporate.invoice.issued',
      reasonCode: 'CORPORATE_RECEIVABLE',
      amount: 172.5, // Qift service invoice: fee 150 + VAT 22.5 (goods excluded)
      direction: 'credit',
      counterpartyType: 'company',
      campaignId: CAMPAIGN,
      orgId: ORG,
      // FIN-4 — deterministic key: retries/repairs collide, never duplicate.
      idempotencyKey: 'corporate.invoice.issued:inv-1',
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

describe('QC invoice numbering (Track A.5 PR 4 — agent model)', () => {
  const ACTOR2 = 'ops-1';

  it('numbers the invoice from the transactional sequence: QC-<year>-NNNNN', async () => {
    const { service, prisma } = build();
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR2);
    const data = prisma.corporateInvoice.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    const year = new Date().getUTCFullYear();
    expect(data.invoiceNumber).toBe(`QC-${year}-00001`);
    // Allocation + create share ONE transaction (gap-free series).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = (prisma.$queryRaw as jest.Mock).mock.calls[0]
      .map(String)
      .join(' ');
    expect(sql).toContain('NumberSequence');
  });

  it('continues the series from the sequence value (zero-padded)', async () => {
    const { service, prisma } = build();
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ lastValue: 123 }]);
    await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR2);
    const data = prisma.corporateInvoice.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    const year = new Date().getUTCFullYear();
    expect(data.invoiceNumber).toBe(`QC-${year}-00123`);
  });

  it('duplicate-campaign race returns the EXISTING numbered row (allocation rolls back with the tx)', async () => {
    const { service, prisma } = build();
    const raced = { id: 'inv-raced', invoiceNumber: 'QC-2026-00007' };
    const { Prisma: RealPrisma } = jest.requireActual('@prisma/client');
    prisma.corporateInvoice.create.mockRejectedValueOnce(
      new RealPrisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.corporateInvoice.findUnique
      .mockResolvedValueOnce(null) // idempotent fast-path: nothing yet
      .mockResolvedValueOnce(raced); // post-race read
    const out = await service.ensureInvoiceForCampaign(ORG, CAMPAIGN, ACTOR2);
    expect(out).toEqual(raced);
  });
});
