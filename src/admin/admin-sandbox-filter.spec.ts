// Closed-beta sandbox filter behaviour on AdminService.
//
// Scope: the three methods that learned a `mode` parameter and the
// helper that maps it. Asserts:
//   - sandboxFilterWhere returns the correct Prisma where-fragment.
//   - listGifts defaults to 'all' and respects sandbox / live overrides.
//   - financeStoreBalances defaults to 'live' (the safer real-money
//     default) and respects the override.
//   - recordPayoutEvent reads the linked Gift's isSandbox and writes
//     it onto the PayoutEvent row; bare adjustments (no giftId)
//     default to false.
//
// PrismaService is mocked at the method level; no real DB.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed in tests; production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { AdminService, sandboxFilterWhere } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from '../stores/stores.service';

describe('sandboxFilterWhere — pure helper', () => {
  it('returns empty object for "all" (no filtering)', () => {
    expect(sandboxFilterWhere('all')).toEqual({});
  });

  it('returns isSandbox=true for "sandbox"', () => {
    expect(sandboxFilterWhere('sandbox')).toEqual({ isSandbox: true });
  });

  it('returns isSandbox=false for "live"', () => {
    expect(sandboxFilterWhere('live')).toEqual({ isSandbox: false });
  });
});

describe('AdminService — sandbox-aware queries', () => {
  let service: AdminService;
  let prisma: {
    gift: { findMany: jest.Mock; findUnique: jest.Mock };
    payoutEvent: { findMany: jest.Mock; create: jest.Mock };
    store: { findMany: jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      gift: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      payoutEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'event_1',
            createdAt: new Date(),
            ...data,
          }),
        ),
      },
      store: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'store_1' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        // AdminService pulls StoresService for v2 merchant-review
        // paths. Not exercised here; stub returns no-op.
        { provide: StoresService, useValue: {} },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  describe('listGifts', () => {
    it("defaults to mode='all' — no isSandbox filter in the where clause", async () => {
      // Preserves closed-beta behaviour: every admin gift-list view
      // shows all rows. Once mixed sandbox + live data exists, the
      // operator picks a mode tab explicitly.
      await service.listGifts();
      const where = prisma.gift.findMany.mock.calls[0][0].where;
      expect(where.isSandbox).toBeUndefined();
    });

    it("mode='sandbox' adds where.isSandbox=true", async () => {
      await service.listGifts('sandbox');
      const where = prisma.gift.findMany.mock.calls[0][0].where;
      expect(where.isSandbox).toBe(true);
    });

    it("mode='live' adds where.isSandbox=false", async () => {
      await service.listGifts('live');
      const where = prisma.gift.findMany.mock.calls[0][0].where;
      expect(where.isSandbox).toBe(false);
    });

    it('exposes isSandbox on each returned row', async () => {
      prisma.gift.findMany.mockResolvedValueOnce([
        {
          id: 'g1',
          productName: 'p',
          storeName: 's',
          status: 'pending_address',
          isAnonymous: false,
          isSandbox: true,
          createdAt: new Date(),
          sender: { id: 's1', qiftUsername: 'sender' },
          receiver: { id: 'r1', qiftUsername: 'receiver' },
        },
      ]);
      const rows = await service.listGifts('all');
      expect(rows[0].isSandbox).toBe(true);
    });
  });

  describe('financeStoreBalances', () => {
    it("defaults to mode='live' — sandbox excluded from real-money totals", async () => {
      // Load-bearing safety property: a default-options call from
      // the admin UI must NEVER include sandbox events in the
      // computed balances. Operators viewing the test ledger opt
      // in explicitly via ?mode=sandbox.
      prisma.store.findMany.mockResolvedValueOnce([
        { id: 'store_1', name: 'Test', owner: { qiftUsername: 'm' } },
      ]);
      await service.financeStoreBalances();
      const where = prisma.payoutEvent.findMany.mock.calls[0][0].where;
      expect(where.isSandbox).toBe(false);
    });

    it("mode='sandbox' includes only test events", async () => {
      prisma.store.findMany.mockResolvedValueOnce([
        { id: 'store_1', name: 'Test', owner: { qiftUsername: 'm' } },
      ]);
      await service.financeStoreBalances('sandbox');
      const where = prisma.payoutEvent.findMany.mock.calls[0][0].where;
      expect(where.isSandbox).toBe(true);
    });

    it("mode='all' drops the sandbox filter", async () => {
      prisma.store.findMany.mockResolvedValueOnce([
        { id: 'store_1', name: 'Test', owner: { qiftUsername: 'm' } },
      ]);
      await service.financeStoreBalances('all');
      const where = prisma.payoutEvent.findMany.mock.calls[0][0].where;
      expect(where.isSandbox).toBeUndefined();
    });
  });

  describe('recordPayoutEvent — isSandbox inheritance from linked Gift', () => {
    const validBody = {
      type: 'accrued',
      amount: 100,
      currency: 'SAR',
      giftId: 'gift_x',
    };

    it('writes isSandbox=true when linked Gift is sandbox', async () => {
      // Defense-in-depth: an admin recording an accrual against a
      // sandbox gift gets a sandbox event. Even if they forget the
      // sandbox classification, the join derives it server-side.
      // financeStoreBalances default-filter then keeps it out of
      // live totals.
      prisma.gift.findUnique.mockResolvedValueOnce({ isSandbox: true });
      await service.recordPayoutEvent('admin_user', 'store_1', validBody);
      const data = prisma.payoutEvent.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(true);
    });

    it('writes isSandbox=false when linked Gift is live', async () => {
      prisma.gift.findUnique.mockResolvedValueOnce({ isSandbox: false });
      await service.recordPayoutEvent('admin_user', 'store_1', validBody);
      const data = prisma.payoutEvent.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(false);
    });

    it('writes isSandbox=false for bare adjustments (no giftId)', async () => {
      // Store-level adjustments (credit, fee waiver) default to
      // live — operators recording them are doing real bookkeeping.
      // Linked-gift derivation is skipped; we never read the gift
      // table.
      await service.recordPayoutEvent('admin_user', 'store_1', {
        type: 'adjustment',
        amount: -10,
        currency: 'SAR',
        reason: 'fee waiver',
      });
      const data = prisma.payoutEvent.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(false);
      expect(prisma.gift.findUnique).not.toHaveBeenCalled();
    });

    it('writes isSandbox=false when giftId references a non-existent gift', async () => {
      // Defensive: a typo / stale id returns null from findUnique;
      // we treat that as "not sandbox" rather than throwing,
      // because the event itself is still valid bookkeeping. The
      // admin can correct via a follow-up adjustment.
      prisma.gift.findUnique.mockResolvedValueOnce(null);
      await service.recordPayoutEvent('admin_user', 'store_1', validBody);
      const data = prisma.payoutEvent.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(false);
    });
  });
});
