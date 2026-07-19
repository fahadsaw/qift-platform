// Ops reconciliation surface (Track B2 / PE-11).
//
// Pinned, in constitutional order:
//   * READ-THEN-REPAIR — findMissing is exposed read-only and
//     separately from repair (Financial Constitution Ch. 18.2).
//   * REFERENCE-CARRYING — every listed object carries its canonical
//     reference beside the cuid (Reference Constitution Ch. 13.8/14.1):
//     QC for corporate invoices, merchant number + provenance for
//     merchant invoices, QP for orders, QB for their campaigns.
//   * AUDITED — the read logs counts-only; the repair logs the ids it
//     posted for + posted count. No PII anywhere.
//   * APPEND-ONLY delegation — repair calls ONLY repairAll (which
//     re-emits deterministic-key events through the single ledger
//     write path); this spec's mock has no update/delete surface.

import { AdminService } from './admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StoresService } from '../stores/stores.service';
import type { AuditService } from '../audit/audit.service';

function mk(missing: {
  corporateInvoiceIds?: string[];
  merchantInvoiceIds?: string[];
  orderIds?: string[];
}) {
  const report = {
    corporateInvoiceIds: missing.corporateInvoiceIds ?? [],
    merchantInvoiceIds: missing.merchantInvoiceIds ?? [],
    orderIds: missing.orderIds ?? [],
  };
  const prisma = {
    corporateInvoice: {
      findMany: jest.fn().mockResolvedValue(
        report.corporateInvoiceIds.map((id) => ({
          id,
          invoiceNumber: 'QC-2026-00007',
          campaignId: 'camp-1',
        })),
      ),
    },
    merchantInvoice: {
      findMany: jest.fn().mockResolvedValue(
        report.merchantInvoiceIds.map((id) => ({
          id,
          merchantInvoiceNumber: null,
          invoiceNumberSource: 'MERCHANT',
          campaignId: 'camp-1',
          storeId: 's-1',
        })),
      ),
    },
    order: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          report.orderIds.map((id) => ({ id, orderNumber: 'QP-AAAA-2222' })),
        ),
    },
    giftCampaign: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'camp-1', referenceNumber: 'QB-TEST-2026' }]),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const reconciliation = {
    findMissing: jest.fn().mockResolvedValue(report),
    repairAll: jest.fn().mockResolvedValue({ missing: report, posted: 2 }),
  };
  const service = new AdminService(
    prisma as unknown as PrismaService,
    {} as unknown as StoresService,
    audit as unknown as AuditService,
    { userHasPermission: jest.fn() } as unknown as ConstructorParameters<
      typeof AdminService
    >[3],
    reconciliation as unknown as ConstructorParameters<typeof AdminService>[4],
  );
  return { prisma, audit, reconciliation, service };
}

describe('AdminService reconciliation (Track B2 / PE-11)', () => {
  it('report enriches every missing object with its canonical reference', async () => {
    const { service } = mk({
      corporateInvoiceIds: ['ci-1'],
      merchantInvoiceIds: ['mi-1'],
      orderIds: ['o-1'],
    });
    const out = await service.reconciliationReport('fin-1');
    expect(out.healthy).toBe(false);
    expect(out.corporateInvoices).toEqual([
      {
        id: 'ci-1',
        invoiceNumber: 'QC-2026-00007',
        campaignId: 'camp-1',
        campaignReference: 'QB-TEST-2026',
      },
    ]);
    expect(out.merchantInvoices[0]).toMatchObject({
      id: 'mi-1',
      merchantInvoiceNumber: null, // honest: merchant hasn't supplied one
      invoiceNumberSource: 'MERCHANT',
      campaignReference: 'QB-TEST-2026',
    });
    expect(out.orders).toEqual([{ id: 'o-1', orderNumber: 'QP-AAAA-2222' }]);
  });

  it('healthy report: empty lists, zero enrichment queries, still audited counts-only', async () => {
    const { prisma, audit, service } = mk({});
    const out = await service.reconciliationReport('fin-1');
    expect(out.healthy).toBe(true);
    expect(prisma.corporateInvoice.findMany).not.toHaveBeenCalled();
    expect(prisma.merchantInvoice.findMany).not.toHaveBeenCalled();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.finance.reconciliation_read',
        metadata: { corporateInvoices: 0, merchantInvoices: 0, orders: 0 },
      }),
    );
  });

  it('read NEVER repairs — findMissing only', async () => {
    const { reconciliation, service } = mk({
      corporateInvoiceIds: ['ci-1'],
    });
    await service.reconciliationReport('fin-1');
    expect(reconciliation.findMissing).toHaveBeenCalledTimes(1);
    expect(reconciliation.repairAll).not.toHaveBeenCalled();
  });

  it('repair delegates to repairAll only and audits ids + posted count', async () => {
    const { audit, reconciliation, service } = mk({
      corporateInvoiceIds: ['ci-1'],
      orderIds: ['o-1'],
    });
    const out = await service.reconciliationRepair('fin-1');
    expect(reconciliation.repairAll).toHaveBeenCalledTimes(1);
    expect(out.posted).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.finance.reconciliation_repair',
        metadata: {
          corporateInvoiceIds: ['ci-1'],
          merchantInvoiceIds: [],
          orderIds: ['o-1'],
          posted: 2,
        },
      }),
    );
  });
});
