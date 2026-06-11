// StoreBusinessService unit tests — B1.
//
// The INDEPENDENCE block is the point of this PR:
//   * consumer approval NEVER implies business eligibility;
//   * business review NEVER touches Store.status (the prisma mock
//     has no store.update — reaching for it would crash);
//   * eligibility requires BOTH approvals, through the single
//     isBusinessEligible() seam.
// Plus: the application gate, the explicit transition table,
// re-application semantics, racing reviewers, and the separate
// audit actions.

import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { StoreBusinessService } from './store-business.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type PrismaMock = {
  store: { findUnique: jest.Mock }; // deliberately NO update
  storeBusinessProfile: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
};

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: 'bp-1',
  storeId: 'store-1',
  status: 'applied',
  ...over,
});

describe('StoreBusinessService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let service: StoreBusinessService;

  beforeEach(() => {
    prisma = {
      store: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'store-1',
          status: 'approved',
          businessProfile: null,
        }),
      },
      storeBusinessProfile: {
        findUnique: jest.fn().mockResolvedValue(profileRow()),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve(profileRow({ ...data })),
        ),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve(profileRow({ ...data })),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new StoreBusinessService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ═════════════════════════════════════════════════════════════════
  describe('INDEPENDENCE — consumer approval grants nothing', () => {
    it('a consumer-approved store with NO business profile is NOT eligible', async () => {
      prisma.store.findUnique.mockResolvedValue({
        status: 'approved',
        businessProfile: null,
      });
      expect(await service.isBusinessEligible('store-1')).toBe(false);
    });

    it.each(['applied', 'rejected', 'suspended'])(
      'a consumer-approved store with a %s business profile is NOT eligible',
      async (status) => {
        prisma.store.findUnique.mockResolvedValue({
          status: 'approved',
          businessProfile: { status },
        });
        expect(await service.isBusinessEligible('store-1')).toBe(false);
      },
    );

    it('a business-approved store that lost CONSUMER approval is NOT eligible either', async () => {
      prisma.store.findUnique.mockResolvedValue({
        status: 'suspended',
        businessProfile: { status: 'approved' },
      });
      expect(await service.isBusinessEligible('store-1')).toBe(false);
    });

    it('eligibility requires BOTH approvals', async () => {
      prisma.store.findUnique.mockResolvedValue({
        status: 'approved',
        businessProfile: { status: 'approved' },
      });
      expect(await service.isBusinessEligible('store-1')).toBe(true);
    });

    it('business review never touches Store.status — the mock has no store.update', async () => {
      await service.review('a1', 'store-1', 'approve', null);
      // If the service ever reached for prisma.store.update, the
      // call above would have crashed on undefined. Belt level:
      expect(
        (prisma.store as unknown as { update?: unknown }).update,
      ).toBeUndefined();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('apply', () => {
    it('requires the store to be consumer-approved first', async () => {
      prisma.store.findUnique.mockResolvedValue({
        id: 'store-1',
        status: 'pending',
        businessProfile: null,
      });
      await expect(service.apply('ops-1', 'store-1')).rejects.toThrow(
        'store_not_consumer_approved',
      );
      expect(prisma.storeBusinessProfile.create).not.toHaveBeenCalled();
    });

    it('404s on a missing store', async () => {
      prisma.store.findUnique.mockResolvedValue(null);
      await expect(service.apply('ops-1', 'store-x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('creates the applied profile and audits the SEPARATE action', async () => {
      await service.apply('ops-1', 'store-1');
      expect(prisma.storeBusinessProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { storeId: 'store-1', appliedBy: 'ops-1' },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.store.business_apply',
          targetType: 'store',
          targetId: 'store-1',
          metadata: expect.objectContaining({ reapplication: false }),
        }),
      );
    });

    it.each(['applied', 'approved', 'suspended'])(
      'an existing %s profile conflicts (409)',
      async (status) => {
        prisma.store.findUnique.mockResolvedValue({
          id: 'store-1',
          status: 'approved',
          businessProfile: profileRow({ status }),
        });
        try {
          await service.apply('ops-1', 'store-1');
          throw new Error('expected apply to throw');
        } catch (e) {
          expect(e).toBeInstanceOf(HttpException);
          expect((e as HttpException).getStatus()).toBe(409);
        }
      },
    );

    it('re-application after REJECTION revives the same row with fresh review state', async () => {
      prisma.store.findUnique.mockResolvedValue({
        id: 'store-1',
        status: 'approved',
        businessProfile: profileRow({ status: 'rejected' }),
      });
      await service.apply('ops-1', 'store-1');
      expect(prisma.storeBusinessProfile.create).not.toHaveBeenCalled();
      expect(prisma.storeBusinessProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bp-1' },
          data: expect.objectContaining({
            status: 'applied',
            reviewedAt: null,
            reviewedBy: null,
            reason: null,
          }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reapplication: true }),
        }),
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('review — explicit transition table', () => {
    const inState = (status: string) =>
      prisma.storeBusinessProfile.findUnique.mockResolvedValue(
        profileRow({ status }),
      );

    it('approve: applied → approved, reviewer stamped, no reason kept', async () => {
      inState('applied');
      await service.review('a1', 'store-1', 'approve', null);
      expect(prisma.storeBusinessProfile.updateMany).toHaveBeenCalledWith({
        where: { id: 'bp-1', status: 'applied' },
        data: expect.objectContaining({
          status: 'approved',
          reviewedBy: 'a1',
          reason: null,
        }),
      });
    });

    it.each(['reject', 'suspend'] as const)(
      '%s requires a reason (shown to the merchant)',
      async (action) => {
        inState(action === 'reject' ? 'applied' : 'approved');
        await expect(
          service.review('a1', 'store-1', action, '  '),
        ).rejects.toThrow('business_review_reason_required');
      },
    );

    it('suspend: approved → suspended with reason; reinstate: suspended → approved', async () => {
      inState('approved');
      await service.review('a1', 'store-1', 'suspend', 'quality issues');
      expect(prisma.storeBusinessProfile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'suspended',
            reason: 'quality issues',
          }),
        }),
      );
      inState('suspended');
      await service.review('a1', 'store-1', 'reinstate', null);
      expect(prisma.storeBusinessProfile.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'approved', reason: null }),
        }),
      );
    });

    it.each([
      ['approve', 'approved'],
      ['reject', 'suspended'],
      ['suspend', 'applied'],
      ['reinstate', 'applied'],
    ] as const)('%s from %s is a 409 wrong-state', async (action, status) => {
      inState(status);
      try {
        await service.review('a1', 'store-1', action, 'reason');
        throw new Error('expected review to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(409);
      }
      expect(prisma.storeBusinessProfile.updateMany).not.toHaveBeenCalled();
    });

    it('unknown action → 400; missing profile → 404', async () => {
      await expect(
        service.review('a1', 'store-1', 'banish' as never, null),
      ).rejects.toThrow(BadRequestException);
      prisma.storeBusinessProfile.findUnique.mockResolvedValue(null);
      await expect(
        service.review('a1', 'store-1', 'approve', null),
      ).rejects.toThrow('business_profile_not_found');
    });

    it('a racing reviewer loses cleanly (conditional flip count 0 → 409, no audit)', async () => {
      inState('applied');
      prisma.storeBusinessProfile.updateMany.mockResolvedValue({ count: 0 });
      try {
        await service.review('a1', 'store-1', 'approve', null);
        throw new Error('expected review to throw');
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(409);
      }
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('audits admin.store.business_review with action + reason', async () => {
      inState('applied');
      await service.review('a1', 'store-1', 'reject', 'incomplete docs');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'a1',
          actorType: 'admin',
          action: 'admin.store.business_review',
          targetType: 'store',
          targetId: 'store-1',
          metadata: { reviewAction: 'reject', reason: 'incomplete docs' },
        }),
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  describe('list', () => {
    it('filters by known statuses only (no filter injection)', async () => {
      await service.list('applied');
      expect(prisma.storeBusinessProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'applied' } }),
      );
      await service.list('<script>');
      expect(prisma.storeBusinessProfile.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });
});
