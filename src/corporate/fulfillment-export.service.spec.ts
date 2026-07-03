// FulfillmentExportService unit tests — Track A5 / PE-06.
//
// Pinned, in the order the invariants demand:
//
//   * CLAIMED ONLY — the query filters status 'claimed'; pending /
//     declined / mismatch / expired recipients never reach the sheet.
//   * TENANT ISOLATION — campaign keyed (id, orgId); a foreign
//     campaign id 404s before any address is read.
//   * ADDRESS JOIN — rows carry the full delivery fields; the
//     recipient's self-entered fullName wins over the roster name,
//     with the roster name as fallback.
//   * ANOMALY SURFACING — a claimed gift with no ClaimAddress row is
//     counted (missingAddressCount), never silently dropped or
//     exported half-empty.
//   * AUDIT IS COUNTS-ONLY — the audit metadata never contains an
//     address, phone, or name; serialized metadata is asserted clean.

import { NotFoundException } from '@nestjs/common';
import { FulfillmentExportService } from './fulfillment-export.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const ADDR_1 = {
  id: 'addr-1',
  claimId: 'claim-1',
  fullName: 'سارة العتيبي',
  phone: '+966501234567',
  country: 'SA',
  region: 'Riyadh Province',
  city: 'Riyadh',
  district: 'Al Olaya',
  line1: 'King Fahd Rd 123, Apt 4',
  notes: 'Call on arrival',
};

const ADDR_2 = {
  id: 'addr-2',
  claimId: 'claim-2',
  fullName: null, // no self-entered name → roster name must be used
  phone: '+966559876543',
  country: 'SA',
  region: null,
  city: 'Jeddah',
  district: null,
  line1: 'Palm St 9',
  notes: null,
};

describe('FulfillmentExportService', () => {
  let prisma: {
    giftCampaign: { findFirst: jest.Mock };
    campaignGiftOption: { findFirst: jest.Mock };
    claimableGift: { findMany: jest.Mock };
    claimAddress: { findMany: jest.Mock };
  };
  let audit: { record: jest.Mock };
  let service: FulfillmentExportService;

  const claimedAt1 = new Date('2026-07-01T10:00:00Z');
  const claimedAt2 = new Date('2026-07-02T11:30:00Z');

  beforeEach(() => {
    prisma = {
      giftCampaign: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'camp-1', name: 'Eid 2026' }),
      },
      campaignGiftOption: {
        findFirst: jest.fn().mockResolvedValue({
          approvalSnapshot: { productName: 'Oud Set', storeName: 'Dar Alteeb' },
        }),
      },
      claimableGift: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'claim-1', recipientName: 'Sara O.', claimedAt: claimedAt1 },
          {
            id: 'claim-2',
            recipientName: 'Mohammed A.',
            claimedAt: claimedAt2,
          },
        ]),
      },
      claimAddress: {
        findMany: jest.fn().mockResolvedValue([ADDR_1, ADDR_2]),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new FulfillmentExportService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  it('exports claimed rows with full delivery fields and gift context', async () => {
    const out = await service.exportCampaignFulfillment(
      'ops-1',
      'org-1',
      'camp-1',
    );

    expect(out.campaign).toEqual({
      campaignId: 'camp-1',
      campaignName: 'Eid 2026',
      productName: 'Oud Set',
      storeName: 'Dar Alteeb',
    });
    expect(out.count).toBe(2);
    expect(out.rows).toEqual([
      {
        recipientName: 'سارة العتيبي', // self-entered name wins
        phone: '+966501234567',
        country: 'SA',
        region: 'Riyadh Province',
        city: 'Riyadh',
        district: 'Al Olaya',
        line1: 'King Fahd Rd 123, Apt 4',
        notes: 'Call on arrival',
        claimedAt: claimedAt1,
      },
      {
        recipientName: 'Mohammed A.', // roster fallback when fullName null
        phone: '+966559876543',
        country: 'SA',
        region: null,
        city: 'Jeddah',
        district: null,
        line1: 'Palm St 9',
        notes: null,
        claimedAt: claimedAt2,
      },
    ]);
  });

  it('queries CLAIMED gifts only — never pending/declined/expired', async () => {
    await service.exportCampaignFulfillment('ops-1', 'org-1', 'camp-1');
    expect(prisma.claimableGift.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { campaignId: 'camp-1', status: 'claimed' },
      }),
    );
  });

  it('404s on a foreign campaign BEFORE reading any address', async () => {
    prisma.giftCampaign.findFirst.mockResolvedValue(null);
    await expect(
      service.exportCampaignFulfillment('ops-1', 'org-OTHER', 'camp-1'),
    ).rejects.toThrow(NotFoundException);
    // Tenant scoping happened in the query itself…
    expect(prisma.giftCampaign.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'camp-1', orgId: 'org-OTHER' },
      }),
    );
    // …and nothing sensitive was touched after the refusal.
    expect(prisma.claimableGift.findMany).not.toHaveBeenCalled();
    expect(prisma.claimAddress.findMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns an empty sheet (still audited) when nothing is claimed yet', async () => {
    prisma.claimableGift.findMany.mockResolvedValue([]);
    prisma.claimAddress.findMany.mockResolvedValue([]);
    const out = await service.exportCampaignFulfillment(
      'ops-1',
      'org-1',
      'camp-1',
    );
    expect(out.count).toBe(0);
    expect(out.rows).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          claimedCount: 0,
          exportedCount: 0,
          missingAddressCount: 0,
        }),
      }),
    );
  });

  it('counts a claimed gift missing its address row instead of dropping it silently', async () => {
    prisma.claimAddress.findMany.mockResolvedValue([ADDR_1]); // claim-2 has none
    const out = await service.exportCampaignFulfillment(
      'ops-1',
      'org-1',
      'camp-1',
    );
    expect(out.count).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].phone).toBe(ADDR_1.phone);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          claimedCount: 2,
          exportedCount: 1,
          missingAddressCount: 1,
        }),
      }),
    );
  });

  it('audit row is counts-only — no address, phone, or name ever', async () => {
    await service.exportCampaignFulfillment('ops-1', 'org-1', 'camp-1');
    expect(audit.record).toHaveBeenCalledTimes(1);
    const call = audit.record.mock.calls[0][0];
    expect(call).toMatchObject({
      actorUserId: 'ops-1',
      actorType: 'user',
      action: 'org.fulfillment.exported',
      targetType: 'organization',
      targetId: 'org-1',
      metadata: {
        campaignId: 'camp-1',
        claimedCount: 2,
        exportedCount: 2,
        missingAddressCount: 0,
      },
    });
    // Belt-and-braces: serialize the metadata and prove no PII leaked.
    const serialized = JSON.stringify(call.metadata);
    for (const pii of [
      ADDR_1.phone,
      ADDR_2.phone,
      ADDR_1.line1,
      ADDR_2.line1,
      'سارة',
      'Mohammed',
      'Riyadh',
      'Jeddah',
    ]) {
      expect(serialized).not.toContain(pii);
    }
  });

  it('missing approval snapshot degrades to null gift context, not a crash', async () => {
    prisma.campaignGiftOption.findFirst.mockResolvedValue(null);
    const out = await service.exportCampaignFulfillment(
      'ops-1',
      'org-1',
      'camp-1',
    );
    expect(out.campaign.productName).toBeNull();
    expect(out.campaign.storeName).toBeNull();
    expect(out.count).toBe(2);
  });
});
