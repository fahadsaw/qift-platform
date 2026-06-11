// CampaignService unit tests — Corporate Foundation PR 3.
//
// Hand-rolled Prisma mock, direct construction (house pattern).
// The load-bearing blocks:
//
//   * SEPARATION OF DUTIES — the creator can never approve or
//     request changes on their own campaign, owners included.
//   * SNAPSHOT-AT-APPROVAL — the approved product + store identity
//     freezes in the same transaction as the status flip, and the
//     product is re-validated live at that moment.
//   * TENANT ISOLATION — campaign loads are keyed (id, orgId);
//     recipient attachment only accepts ACTIVE contacts of the SAME
//     org and reports everything else as skipped.
//   * State machine edges — editable / submittable / approvable /
//     cancellable matrices.

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CampaignService,
  MAX_CAMPAIGN_RECIPIENTS,
} from './campaign.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type PrismaMock = {
  organization: { findUnique: jest.Mock };
  giftCampaign: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
  campaignGiftOption: {
    deleteMany: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  campaignRecipient: {
    createMany: jest.Mock;
    count: jest.Mock;
    deleteMany: jest.Mock;
  };
  corporateContact: { findMany: jest.Mock };
  product: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};

const campaignRow = (over: Record<string, unknown> = {}) => ({
  id: 'camp-1',
  status: 'draft',
  createdBy: 'maker-1',
  ...over,
});

const liveProduct = (over: Record<string, unknown> = {}) => ({
  id: 'prod-1',
  name: 'علبة تمر فاخرة',
  price: 149.5,
  imageUrl: 'https://cdn.qift.net/p/prod-1.jpg',
  category: 'dates',
  isAvailable: true,
  stockStatus: 'in_stock',
  storeId: 'store-1',
  store: { id: 'store-1', name: 'متجر التمور', status: 'approved' },
  ...over,
});

describe('CampaignService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let service: CampaignService;

  beforeEach(() => {
    prisma = {
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'approved' }),
      },
      giftCampaign: {
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(campaignRow(data))),
        findFirst: jest.fn().mockResolvedValue(campaignRow()),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(campaignRow(data))),
      },
      campaignGiftOption: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'opt-1' }),
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'opt-1', productId: 'prod-1' }),
        update: jest.fn().mockResolvedValue({ id: 'opt-1' }),
      },
      campaignRecipient: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(1),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      corporateContact: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findUnique: jest.fn().mockResolvedValue(liveProduct()) },
      $transaction: jest
        .fn()
        .mockImplementation((arg) =>
          Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
        ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new CampaignService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────
  describe('createCampaign', () => {
    it('requires a name and an APPROVED org', async () => {
      await expect(
        service.createCampaign('u1', 'org-1', { name: 'ab' }),
      ).rejects.toThrow('campaign_name_required');
      prisma.organization.findUnique.mockResolvedValue({ status: 'draft' });
      await expect(
        service.createCampaign('u1', 'org-1', { name: 'Eid 2026' }),
      ).rejects.toThrow('org_not_approved');
    });

    it('creates a draft stamped with the maker and audits it', async () => {
      await service.createCampaign('maker-1', 'org-1', { name: 'Eid 2026' });
      expect(prisma.giftCampaign.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orgId: 'org-1',
            name: 'Eid 2026',
            createdBy: 'maker-1',
          }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'org.campaign.create' }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('tenant isolation', () => {
    it('loads campaigns keyed (id, orgId) — another org’s campaign reads as missing', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(null);
      await expect(
        service.submitForApproval('u1', 'org-1', 'campaign-of-org-2'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.giftCampaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'campaign-of-org-2', orgId: 'org-1' },
        }),
      );
    });

    it('addRecipients only attaches ACTIVE contacts of THIS org; the rest are skipped', async () => {
      prisma.corporateContact.findMany.mockResolvedValue([{ id: 'c-mine' }]);
      prisma.campaignRecipient.createMany.mockResolvedValue({ count: 1 });
      const res = await service.addRecipients('u1', 'org-1', 'camp-1', [
        'c-mine',
        'c-of-other-org',
        'c-archived',
      ]);
      expect(prisma.corporateContact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: ['c-mine', 'c-of-other-org', 'c-archived'] },
            orgId: 'org-1',
            status: 'active',
          },
        }),
      );
      const { data } = prisma.campaignRecipient.createMany.mock.calls[0][0];
      expect(data).toEqual([{ campaignId: 'camp-1', contactId: 'c-mine' }]);
      expect(res).toEqual({ added: 1, skipped: 2 });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('setGiftOption', () => {
    it('replaces the existing option (one-gift-for-all MVP)', async () => {
      await service.setGiftOption('u1', 'org-1', 'camp-1', 'prod-1');
      expect(prisma.campaignGiftOption.deleteMany).toHaveBeenCalledWith({
        where: { campaignId: 'camp-1' },
      });
      expect(prisma.campaignGiftOption.create).toHaveBeenCalledWith({
        data: { campaignId: 'camp-1', productId: 'prod-1' },
      });
    });

    it('rejects unavailable / out-of-stock products at draft time', async () => {
      prisma.product.findUnique.mockResolvedValue(
        liveProduct({ stockStatus: 'out_of_stock' }),
      );
      await expect(
        service.setGiftOption('u1', 'org-1', 'camp-1', 'prod-1'),
      ).rejects.toThrow('product_unavailable');
    });

    it.each(['pending_approval', 'approved', 'cancelled'])(
      'refuses edits in %s',
      async (status) => {
        prisma.giftCampaign.findFirst.mockResolvedValue(campaignRow({ status }));
        await expect(
          service.setGiftOption('u1', 'org-1', 'camp-1', 'prod-1'),
        ).rejects.toThrow('campaign_not_editable');
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────
  describe('recipient cap', () => {
    it('refuses to exceed MAX_CAMPAIGN_RECIPIENTS', async () => {
      prisma.corporateContact.findMany.mockResolvedValue([{ id: 'c-1' }]);
      prisma.campaignRecipient.count.mockResolvedValue(MAX_CAMPAIGN_RECIPIENTS);
      await expect(
        service.addRecipients('u1', 'org-1', 'camp-1', ['c-1']),
      ).rejects.toThrow('campaign_recipient_cap_exceeded');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('submitForApproval', () => {
    it('requires at least one option and one recipient', async () => {
      prisma.campaignGiftOption.count.mockResolvedValue(0);
      await expect(
        service.submitForApproval('u1', 'org-1', 'camp-1'),
      ).rejects.toThrow('campaign_option_required');

      prisma.campaignGiftOption.count.mockResolvedValue(1);
      prisma.campaignRecipient.count.mockResolvedValue(0);
      await expect(
        service.submitForApproval('u1', 'org-1', 'camp-1'),
      ).rejects.toThrow('campaign_recipients_required');
    });

    it('moves draft → pending_approval and clears any stale review note', async () => {
      await service.submitForApproval('u1', 'org-1', 'camp-1');
      expect(prisma.giftCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'pending_approval',
            submittedAt: expect.any(Date),
            reviewNote: null,
          }),
        }),
      );
    });

    it('allows resubmission from changes_requested', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(
        campaignRow({ status: 'changes_requested' }),
      );
      await expect(
        service.submitForApproval('u1', 'org-1', 'camp-1'),
      ).resolves.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('approveCampaign — separation of duties', () => {
    const pending = (over: Record<string, unknown> = {}) =>
      prisma.giftCampaign.findFirst.mockResolvedValue(
        campaignRow({ status: 'pending_approval', ...over }),
      );

    it('THE CREATOR CANNOT APPROVE THEIR OWN CAMPAIGN — owner included', async () => {
      pending({ createdBy: 'owner-1' });
      await expect(
        service.approveCampaign('owner-1', 'org-1', 'camp-1'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.approveCampaign('owner-1', 'org-1', 'camp-1'),
      ).rejects.toThrow('campaign_sod_creator_cannot_approve');
      expect(prisma.giftCampaign.update).not.toHaveBeenCalled();
    });

    it('the creator cannot request changes either — reviewing is reviewing', async () => {
      pending({ createdBy: 'maker-1' });
      await expect(
        service.requestChanges('maker-1', 'org-1', 'camp-1', 'note'),
      ).rejects.toThrow('campaign_sod_creator_cannot_approve');
    });

    it('a different approver passes the SoD lock', async () => {
      pending({ createdBy: 'maker-1' });
      await expect(
        service.approveCampaign('checker-1', 'org-1', 'camp-1'),
      ).resolves.toBeDefined();
    });

    it('only pending_approval campaigns can be approved', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(
        campaignRow({ status: 'draft' }),
      );
      await expect(
        service.approveCampaign('checker-1', 'org-1', 'camp-1'),
      ).rejects.toThrow('campaign_not_pending');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('approveCampaign — snapshot-at-approval', () => {
    beforeEach(() =>
      prisma.giftCampaign.findFirst.mockResolvedValue(
        campaignRow({ status: 'pending_approval', createdBy: 'maker-1' }),
      ),
    );

    it('freezes product + store identity in the same transaction as the flip', async () => {
      await service.approveCampaign('checker-1', 'org-1', 'camp-1');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.giftCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'approved',
            approvedBy: 'checker-1',
            approvedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.campaignGiftOption.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'opt-1' },
          data: {
            approvalSnapshot: {
              productId: 'prod-1',
              productName: 'علبة تمر فاخرة',
              price: 149.5,
              imageUrl: 'https://cdn.qift.net/p/prod-1.jpg',
              category: 'dates',
              storeId: 'store-1',
              storeName: 'متجر التمور',
            },
            snapshotAt: expect.any(Date),
          },
        }),
      );
    });

    it('re-validates the product LIVE at approval — a delisted gift cannot be approved', async () => {
      prisma.product.findUnique.mockResolvedValue(
        liveProduct({ isAvailable: false }),
      );
      await expect(
        service.approveCampaign('checker-1', 'org-1', 'camp-1'),
      ).rejects.toThrow('product_unavailable');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a suspended merchant blocks approval too', async () => {
      prisma.product.findUnique.mockResolvedValue(
        liveProduct({ store: { id: 's', name: 'x', status: 'suspended' } }),
      );
      await expect(
        service.approveCampaign('checker-1', 'org-1', 'camp-1'),
      ).rejects.toThrow('product_unavailable');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('requestChanges / cancel', () => {
    it('request_changes requires a note the maker can act on', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(
        campaignRow({ status: 'pending_approval' }),
      );
      await expect(
        service.requestChanges('checker-1', 'org-1', 'camp-1', '  '),
      ).rejects.toThrow('campaign_review_note_required');
      await service.requestChanges('checker-1', 'org-1', 'camp-1', 'Swap gift');
      expect(prisma.giftCampaign.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'changes_requested', reviewNote: 'Swap gift' },
        }),
      );
    });

    it.each(['draft', 'pending_approval', 'changes_requested', 'approved'])(
      'cancel is allowed from %s',
      async (status) => {
        prisma.giftCampaign.findFirst.mockResolvedValue(campaignRow({ status }));
        await expect(
          service.cancelCampaign('u1', 'org-1', 'camp-1'),
        ).resolves.toBeDefined();
      },
    );

    it.each(['cancelled', 'dispatching', 'completed'])(
      'cancel is refused from %s',
      async (status) => {
        prisma.giftCampaign.findFirst.mockResolvedValue(campaignRow({ status }));
        await expect(
          service.cancelCampaign('u1', 'org-1', 'camp-1'),
        ).rejects.toThrow('campaign_not_cancellable');
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────
  describe('reads', () => {
    it('list is counts-only (no recipient PII) and org-scoped', async () => {
      await service.listCampaigns('org-1');
      const arg = prisma.giftCampaign.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ orgId: 'org-1' });
      expect(arg.select._count).toBeDefined();
      expect(arg.select.recipients).toBeUndefined();
    });

    it('detail is keyed (id, orgId) and 404s across tenants', async () => {
      prisma.giftCampaign.findFirst.mockResolvedValue(null);
      await expect(service.getCampaign('org-1', 'camp-x')).rejects.toThrow(
        'campaign_not_found',
      );
    });
  });
});
