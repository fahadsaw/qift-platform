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
        findFirst: jest.fn().mockResolvedValue({
          id: 'camp-1',
          referenceNumber: 'QB-TEST-2026',
          name: 'Eid 2026',
        }),
      },
      campaignGiftOption: {
        findFirst: jest.fn().mockResolvedValue({
          approvalSnapshot: { productName: 'Oud Set', storeName: 'Dar Alteeb' },
        }),
      },
      claimableGift: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'claim-1',
            giftReference: 'QG-AAAA-2222',
            recipientName: 'Sara O.',
            claimedAt: claimedAt1,
          },
          {
            id: 'claim-2',
            giftReference: 'QG-BBBB-3333',
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
      campaignReference: 'QB-TEST-2026',
      campaignName: 'Eid 2026',
      productName: 'Oud Set',
      storeName: 'Dar Alteeb',
    });
    expect(out.count).toBe(2);
    expect(out.rows).toEqual([
      {
        giftReference: 'QG-AAAA-2222',
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
        giftReference: 'QG-BBBB-3333',
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

describe('lookupClaimByReference (Track A.5 PR 3 — support lookup)', () => {
  // Narrow harness. STRUCTURAL read-only guarantee: the claimableGift
  // mock has NO create/update/upsert and there is NO mint service —
  // if the lookup ever tried to rotate anything, these tests crash.
  const CLAIM = {
    giftReference: 'QG-AAAA-2222',
    status: 'claimed',
    recipientName: 'سارة العتيبي',
    channel: 'phone',
    claimedAt: new Date('2026-07-01T10:00:00Z'),
    declinedAt: null,
    expiresAt: new Date('2026-07-10T10:00:00Z'),
    campaign: {
      id: 'camp-1',
      referenceNumber: 'QB-TEST-2026',
      name: 'Eid 2026',
      orgId: 'org-1',
    },
  };

  const mk = () => {
    const prisma = {
      claimableGift: { findUnique: jest.fn().mockResolvedValue(CLAIM) },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FulfillmentExportService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    return { prisma, audit, service };
  };

  it('resolves a normalized reference to claim state + campaign context', async () => {
    const { prisma, service } = mk();
    // lower-case, dash-less input still resolves (search contract).
    const out = await service.lookupClaimByReference('ops-1', 'qg aaaa 2222');
    expect(prisma.claimableGift.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { giftReference: 'QG-AAAA-2222' } }),
    );
    expect(out).toMatchObject({
      giftReference: 'QG-AAAA-2222',
      status: 'claimed',
      recipientName: 'سارة العتيبي',
      campaign: {
        campaignId: 'camp-1',
        campaignReference: 'QB-TEST-2026',
        campaignName: 'Eid 2026',
        orgId: 'org-1',
      },
    });
    // No address, no channel VALUE, no token material in the payload.
    const serialized = JSON.stringify(out);
    for (const banned of ['line1', 'phone:', 'tokenHash', 'channelValue']) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('rejects non-QG input before touching the database', async () => {
    const { prisma, service } = mk();
    for (const bad of ['QB-AAAA-2222', 'hello', 'clzy8p2qk0000356m']) {
      await expect(
        service.lookupClaimByReference('ops-1', bad),
      ).rejects.toThrow('invalid_gift_reference');
    }
    expect(prisma.claimableGift.findUnique).not.toHaveBeenCalled();
  });

  it('404s an unknown reference; audit only fires on success', async () => {
    const { prisma, audit, service } = mk();
    prisma.claimableGift.findUnique.mockResolvedValue(null);
    await expect(
      service.lookupClaimByReference('ops-1', 'QG-ZZZZ-9999'),
    ).rejects.toThrow('claim_not_found');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits reference + campaign only — never the recipient name', async () => {
    const { audit, service } = mk();
    await service.lookupClaimByReference('ops-1', 'QG-AAAA-2222');
    const call = audit.record.mock.calls[0][0];
    expect(call).toMatchObject({
      action: 'org.claim.lookup',
      targetType: 'organization',
      targetId: 'org-1',
      metadata: { giftReference: 'QG-AAAA-2222', campaignId: 'camp-1' },
    });
    expect(JSON.stringify(call)).not.toContain('سارة');
  });
});
