// Ops cross-reference search — role-based disclosure (Track A.5 PR 9).
//
// Pinned:
//   * QP / QF resolve under the endpoint's own diagnostics.read gate.
//   * QB / QG / QC are CORPORATE: without org.review the hit is
//     { restricted: true } and carries ZERO data — no name, no org,
//     no status. With org.review they resolve.
//   * QG search hits never carry the recipient's name — that lives
//     only behind the dedicated org.review lookup endpoint.
//   * Non-reference terms produce no references group entries.

import { AdminService } from './admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StoresService } from '../stores/stores.service';
import type { AuditService } from '../audit/audit.service';

function makeService(hasOrgReview: boolean) {
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue([]) },
    store: { findMany: jest.fn().mockResolvedValue([]) },
    gift: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        id: 'g-1',
        status: 'shipped',
        productName: 'Oud Set',
        storeName: 'Dar Alteeb',
      }),
    },
    order: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'o-1',
        status: 'paid',
        productName: 'Oud Set',
        storeName: 'Dar Alteeb',
        giftId: 'g-1',
      }),
    },
    giftCampaign: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'camp-1',
        name: 'Eid 2026',
        status: 'approved',
        orgId: 'org-1',
      }),
    },
    claimableGift: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'claim-1',
        status: 'claimed',
        recipientName: 'سارة العتيبي', // present on the row…
        campaign: {
          id: 'camp-1',
          referenceNumber: 'QB-TEST-2026',
          orgId: 'org-1',
        },
      }),
    },
    corporateInvoice: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'inv-1',
        status: 'issued',
        orgId: 'org-1',
        campaignId: 'camp-1',
      }),
    },
  };
  const opsRoles = {
    userHasPermission: jest.fn().mockResolvedValue(hasOrgReview),
  };
  const service = new AdminService(
    prisma as unknown as PrismaService,
    {} as unknown as StoresService,
    {} as unknown as AuditService,
    opsRoles as unknown as ConstructorParameters<typeof AdminService>[3],
  );
  return { prisma, opsRoles, service };
}

describe('opsSearch canonical-reference resolution', () => {
  it('resolves a QP order reference (case/dash-blind input)', async () => {
    const { service } = makeService(false);
    const res = await service.opsSearch('qp aaaa 2222', 'ops-1');
    expect(res.references).toEqual([
      {
        kind: 'personal_order',
        reference: 'QP-AAAA-2222',
        status: 'paid',
        label: 'Oud Set — Dar Alteeb',
        orderId: 'o-1',
        giftId: 'g-1',
      },
    ]);
  });

  it('resolves a QF fulfillment reference', async () => {
    const { service } = makeService(false);
    const res = await service.opsSearch('QF-AAAA-2222', 'ops-1');
    expect(res.references[0]).toMatchObject({
      kind: 'merchant_fulfillment',
      giftId: 'g-1',
      status: 'shipped',
    });
  });

  it('QB/QG/QC WITHOUT org.review: restricted, zero data, zero corporate queries', async () => {
    const { prisma, service } = makeService(false);
    for (const [ref, kind] of [
      ['QB-AAAA-2222', 'business_campaign'],
      ['QG-AAAA-2222', 'recipient_gift'],
      ['QC-2026-00001', 'qift_service_invoice'],
    ] as const) {
      const res = await service.opsSearch(ref, 'ops-1');
      expect(res.references).toEqual([
        { kind, reference: ref, restricted: true },
      ]);
    }
    expect(prisma.giftCampaign.findUnique).not.toHaveBeenCalled();
    expect(prisma.claimableGift.findUnique).not.toHaveBeenCalled();
    expect(prisma.corporateInvoice.findUnique).not.toHaveBeenCalled();
  });

  it('QB/QG/QC WITH org.review resolve; QG never leaks the recipient name', async () => {
    const { service } = makeService(true);
    const qb = await service.opsSearch('QB-AAAA-2222', 'ops-1');
    expect(qb.references[0]).toMatchObject({
      kind: 'business_campaign',
      label: 'Eid 2026',
      orgId: 'org-1',
    });
    const qg = await service.opsSearch('QG-AAAA-2222', 'ops-1');
    expect(qg.references[0]).toMatchObject({
      kind: 'recipient_gift',
      status: 'claimed',
      label: 'QB-TEST-2026',
    });
    expect(JSON.stringify(qg.references)).not.toContain('سارة');
    const qc = await service.opsSearch('QC-2026-00001', 'ops-1');
    expect(qc.references[0]).toMatchObject({
      kind: 'qift_service_invoice',
      invoiceId: 'inv-1',
    });
  });

  it('a non-reference term yields an empty references group', async () => {
    const { service } = makeService(true);
    const res = await service.opsSearch('oud set', 'ops-1');
    expect(res.references).toEqual([]);
  });
});
