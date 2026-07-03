import { NotFoundException } from '@nestjs/common';
import { LedgerReconciliationService } from './ledger-reconciliation.service';
import { FINANCIAL_EVENTS, ledgerIdempotencyKey } from './financial-events';

const CORP_INVOICE = {
  id: 'inv-1',
  campaignId: 'camp-1',
  orgId: 'org-1',
  status: 'issued',
  currency: 'SAR',
  recipientCount: 10,
  totalAmount: 172.5,
};

const MERCH_INVOICE = {
  id: 'minv-1',
  campaignId: 'camp-1',
  orgId: 'org-1',
  storeId: 'store-1',
  status: 'issued',
  currency: 'SAR',
  recipientCount: 10,
  totalAmount: 5750,
};

const PAID_ORDER = {
  id: 'order-1',
  userId: 'user-1',
  storeId: 'store-1',
  status: 'paid',
  productPrice: 220,
  serviceFee: 7,
  deliveryFee: 15,
  totalAmount: 242,
  currency: 'SAR',
  paymentProvider: 'mock',
  payment: { id: 'pay-1' },
};

function build(
  opts: {
    corpInvoices?: unknown[];
    merchInvoices?: unknown[];
    paidOrders?: unknown[];
    ledgerEntries?: Array<Record<string, unknown>>;
    corpInvoice?: unknown; // findUnique result
    merchInvoice?: unknown;
    order?: unknown;
    existingKeys?: string[]; // keys findByIdempotencyKey resolves
  } = {},
) {
  const prisma = {
    corporateInvoice: {
      findMany: jest.fn().mockResolvedValue(opts.corpInvoices ?? []),
      findUnique: jest
        .fn()
        .mockResolvedValue('corpInvoice' in opts ? opts.corpInvoice : null),
    },
    merchantInvoice: {
      findMany: jest.fn().mockResolvedValue(opts.merchInvoices ?? []),
      findUnique: jest
        .fn()
        .mockResolvedValue('merchInvoice' in opts ? opts.merchInvoice : null),
    },
    order: {
      findMany: jest.fn().mockResolvedValue(opts.paidOrders ?? []),
      findUnique: jest
        .fn()
        .mockResolvedValue('order' in opts ? opts.order : null),
    },
    financialLedgerEntry: {
      findMany: jest.fn().mockImplementation(({ where }) => {
        const entries = opts.ledgerEntries ?? [];
        return Promise.resolve(
          entries.filter((e) => e.reasonCode === where.reasonCode),
        );
      }),
    },
  };
  const existing = new Set(opts.existingKeys ?? []);
  const ledger = {
    record: jest
      .fn()
      .mockImplementation((input: { idempotencyKey?: string }) =>
        Promise.resolve({ id: 'led-new', ...input }),
      ),
    findByIdempotencyKey: jest
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(
          existing.has(key) ? { id: 'led-old', idempotencyKey: key } : null,
        ),
      ),
  };
  const service = new LedgerReconciliationService(
    prisma as never,
    ledger as never,
  );
  return { service, prisma, ledger };
}

describe('LedgerReconciliationService (FIN-4)', () => {
  describe('findMissing — reconciliation visibility', () => {
    it('reports issued invoices and paid orders with no ledger posting', async () => {
      const { service } = build({
        corpInvoices: [{ id: 'inv-1', campaignId: 'camp-1' }],
        merchInvoices: [{ id: 'minv-1', campaignId: 'camp-1' }],
        paidOrders: [{ id: 'order-1' }],
        ledgerEntries: [],
      });
      const missing = await service.findMissing();
      expect(missing).toEqual({
        corporateInvoiceIds: ['inv-1'],
        merchantInvoiceIds: ['minv-1'],
        orderIds: ['order-1'],
      });
    });

    it('treats a deterministic-key match as posted', async () => {
      const { service } = build({
        corpInvoices: [{ id: 'inv-1', campaignId: 'camp-1' }],
        ledgerEntries: [
          {
            reasonCode: 'CORPORATE_RECEIVABLE',
            campaignId: 'other-camp',
            idempotencyKey: ledgerIdempotencyKey(
              FINANCIAL_EVENTS.CORPORATE_INVOICE_ISSUED,
              'inv-1',
            ),
          },
        ],
      });
      const missing = await service.findMissing();
      expect(missing.corporateInvoiceIds).toEqual([]);
    });

    it('treats a legacy key-less campaign match as posted (no false repair)', async () => {
      const { service } = build({
        merchInvoices: [{ id: 'minv-1', campaignId: 'camp-1' }],
        ledgerEntries: [
          {
            reasonCode: 'MERCHANT_GOODS_INVOICED',
            campaignId: 'camp-1',
            idempotencyKey: null, // pre-FIN-4 row
          },
        ],
      });
      const missing = await service.findMissing();
      expect(missing.merchantInvoiceIds).toEqual([]);
    });
  });

  describe('invoice ledger repair', () => {
    it('backfills the receivable from the persisted invoice row with the deterministic key', async () => {
      const { service, ledger } = build({ corpInvoice: CORP_INVOICE });
      const out = await service.repairCorporateInvoice('inv-1');
      expect(out).toEqual({ posted: 1, alreadyPresent: 0 });
      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'corporate.invoice.issued',
          reasonCode: 'CORPORATE_RECEIVABLE',
          amount: 172.5,
          direction: 'credit',
          counterpartyType: 'company',
          campaignId: 'camp-1',
          orgId: 'org-1',
          idempotencyKey: 'corporate.invoice.issued:inv-1',
          metadata: expect.objectContaining({ repairedBackfill: true }),
        }),
      );
    });

    it('merchant invoice repair posts the goods leg as pass-through', async () => {
      const { service, ledger } = build({ merchInvoice: MERCH_INVOICE });
      const out = await service.repairMerchantInvoice('minv-1');
      expect(out).toEqual({ posted: 1, alreadyPresent: 0 });
      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'merchant.invoice.issued',
          reasonCode: 'MERCHANT_GOODS_INVOICED',
          amount: 5750,
          storeId: 'store-1',
          idempotencyKey: 'merchant.invoice.issued:minv-1',
          metadata: expect.objectContaining({
            passThrough: true,
            repairedBackfill: true,
          }),
        }),
      );
    });

    it('repeated repair is safe — existing posting means no new entry', async () => {
      const { service, ledger } = build({
        corpInvoice: CORP_INVOICE,
        existingKeys: ['corporate.invoice.issued:inv-1'],
      });
      const out = await service.repairCorporateInvoice('inv-1');
      expect(out).toEqual({ posted: 0, alreadyPresent: 1 });
      expect(ledger.record).not.toHaveBeenCalled();
    });

    it('converts Decimal invoice totals at the boundary', async () => {
      const { service, ledger } = build({
        corpInvoice: {
          ...CORP_INVOICE,
          totalAmount: { toNumber: () => 172.5 },
        },
      });
      await service.repairCorporateInvoice('inv-1');
      expect(ledger.record.mock.calls[0][0].amount).toBe(172.5);
    });

    it('unknown invoice id → NotFound', async () => {
      const { service } = build();
      await expect(service.repairCorporateInvoice('nope')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.repairMerchantInvoice('nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('order ledger repair', () => {
    it('backfills all four legs for a paid order, marked as repair', async () => {
      const { service, ledger } = build({ order: PAID_ORDER });
      const out = await service.repairOrder('order-1');
      expect(out).toEqual({ posted: 4, alreadyPresent: 0 });
      const reasons = ledger.record.mock.calls.map(
        (c: [Record<string, unknown>]) => c[0].reasonCode,
      );
      expect(reasons).toEqual([
        'ORDER_PAID',
        'QIFT_SERVICE_FEE',
        'MERCHANT_PAYABLE',
        'DELIVERY_FEE',
      ]);
      for (const call of ledger.record.mock.calls) {
        expect(call[0].idempotencyKey).toMatch(/:order-1$/);
        expect(
          (call[0].metadata as Record<string, unknown>).repairedBackfill,
        ).toBe(true);
      }
    });

    it('partial backfill: only the missing legs are posted', async () => {
      const { service, ledger } = build({
        order: PAID_ORDER,
        existingKeys: [
          ledgerIdempotencyKey(FINANCIAL_EVENTS.ORDER_PAID, 'order-1'),
          ledgerIdempotencyKey(
            FINANCIAL_EVENTS.QIFT_SERVICE_FEE_ACCRUED,
            'order-1',
          ),
        ],
      });
      const out = await service.repairOrder('order-1');
      expect(out).toEqual({ posted: 2, alreadyPresent: 2 });
      const reasons = ledger.record.mock.calls.map(
        (c: [Record<string, unknown>]) => c[0].reasonCode,
      );
      expect(reasons).toEqual(['MERCHANT_PAYABLE', 'DELIVERY_FEE']);
    });

    it('a non-paid order is a safe no-op, not an error', async () => {
      const { service, ledger } = build({
        order: { ...PAID_ORDER, status: 'pending' },
      });
      const out = await service.repairOrder('order-1');
      expect(out).toEqual({ posted: 0, alreadyPresent: 0 });
      expect(ledger.record).not.toHaveBeenCalled();
    });

    it('unknown order id → NotFound', async () => {
      const { service } = build();
      await expect(service.repairOrder('nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('repairAll — the idempotent sweep', () => {
    it('repairs everything missing and reports the count', async () => {
      const { service, ledger } = build({
        corpInvoices: [{ id: 'inv-1', campaignId: 'camp-1' }],
        merchInvoices: [{ id: 'minv-1', campaignId: 'camp-1' }],
        paidOrders: [{ id: 'order-1' }],
        corpInvoice: CORP_INVOICE,
        merchInvoice: MERCH_INVOICE,
        order: PAID_ORDER,
      });
      const out = await service.repairAll();
      expect(out.missing.corporateInvoiceIds).toEqual(['inv-1']);
      expect(out.posted).toBe(6); // 1 + 1 + 4 order legs
      expect(ledger.record).toHaveBeenCalledTimes(6);
    });

    it('a second sweep posts nothing (repeated ensure is safe)', async () => {
      const { service, ledger } = build({
        corpInvoices: [{ id: 'inv-1', campaignId: 'camp-1' }],
        ledgerEntries: [
          {
            reasonCode: 'CORPORATE_RECEIVABLE',
            campaignId: 'camp-1',
            idempotencyKey: 'corporate.invoice.issued:inv-1',
          },
        ],
      });
      const out = await service.repairAll();
      expect(out.missing).toEqual({
        corporateInvoiceIds: [],
        merchantInvoiceIds: [],
        orderIds: [],
      });
      expect(out.posted).toBe(0);
      expect(ledger.record).not.toHaveBeenCalled();
    });
  });

  it('repair metadata carries no PII', async () => {
    const { service, ledger } = build({
      corpInvoice: CORP_INVOICE,
      merchInvoice: MERCH_INVOICE,
      order: PAID_ORDER,
    });
    await service.repairCorporateInvoice('inv-1');
    await service.repairMerchantInvoice('minv-1');
    await service.repairOrder('order-1');
    const flat = JSON.stringify(
      ledger.record.mock.calls.map((c: [unknown]) => c[0]),
    ).toLowerCase();
    for (const banned of [
      'recipientname',
      'phone',
      'address',
      'street',
      'claimchoice',
    ]) {
      expect(flat).not.toContain(banned);
    }
  });
});
