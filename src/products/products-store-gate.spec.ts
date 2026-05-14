// QA-audit follow-up: store-status gate on the public product
// surfaces (ProductsService.list / findOne / checkAvailability).
//
// Background: pre-audit, `GET /products?storeId=…` and
// `GET /products/:id` were anonymous routes that returned products
// from ANY store, including draft / submitted / pending_review /
// changes_requested / rejected / suspended. The buyer flow
// (`checkAvailability`, called from Orders + Gifts) also didn't
// gate on store status, so a stale wishlist or bookmarked product
// URL could complete an order against a suspended store.
//
// PUBLIC_STORE_STATUSES (exported from stores.service.ts) is the
// single allow-list. Currently: ['approved', 'pending'] —
// 'pending' is the legacy alias pre-v2 stores were backfilled to.
//
// These tests assert each surface refuses non-public stores while
// remaining functional for approved ones.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from '../stores/stores.service';

type MockPrisma = {
  store: { findFirst: jest.Mock; findUnique: jest.Mock };
  product: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
};

function createPrismaMock(): MockPrisma {
  return {
    store: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    product: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };
}

const STORE_ID = 'store-1';
const PRODUCT_ID = 'product-1';

describe('ProductsService — store-status gate', () => {
  let service: ProductsService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        // StoresService is injected but unused in the public-read
        // paths under test (it's used only by mutation paths like
        // create/update/remove via assertOwner). A stub is enough.
        {
          provide: StoresService,
          useValue: { assertOwner: jest.fn() },
        },
      ],
    }).compile();
    service = module.get<ProductsService>(ProductsService);
  });

  describe('list', () => {
    it('returns [] when the parent store is in a non-public status', async () => {
      // findFirst short-circuits — the status filter rejects the
      // store, so no product query ever runs.
      prisma.store.findFirst.mockResolvedValue(null);

      const out = await service.list(STORE_ID);
      expect(out).toEqual([]);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it('passes status: { in: PUBLIC_STORE_STATUSES } to the store lookup', async () => {
      prisma.store.findFirst.mockResolvedValue(null);
      await service.list(STORE_ID);
      const call = prisma.store.findFirst.mock.calls[0][0];
      expect(call.where.id).toBe(STORE_ID);
      // The IN array must include 'approved'. We don't pin the
      // entire array so adding 'pending' (legacy alias) or new
      // public-eligible states doesn't break this test.
      expect(call.where.status.in).toEqual(
        expect.arrayContaining(['approved']),
      );
    });

    it('returns products when the store is approved', async () => {
      prisma.store.findFirst.mockResolvedValue({ metricsVisibility: null });
      prisma.product.findMany.mockResolvedValue([
        {
          id: PRODUCT_ID,
          storeId: STORE_ID,
          name: 'Roses',
          price: 100,
          imageUrl: null,
          category: 'flowers',
          isFastDelivery: true,
          sourceType: 'manual',
          externalProductId: null,
          stockStatus: 'in_stock',
          isAvailable: true,
          lastSyncedAt: null,
          createdAt: new Date(),
          images: [],
          wishlistedByCount: 5,
          giftedByCount: 2,
          trendingAt: null,
        },
      ]);

      const out = await service.list(STORE_ID);
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe(PRODUCT_ID);
    });

    it('returns [] immediately when storeId is empty (no DB call)', async () => {
      const out = await service.list('');
      expect(out).toEqual([]);
      expect(prisma.store.findFirst).not.toHaveBeenCalled();
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when the parent store is non-public', async () => {
      // findFirst with the store-status join returns null because
      // the parent store doesn't satisfy the status filter.
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(service.findOne(PRODUCT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('joins the store status filter into the product lookup', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.findOne(PRODUCT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const call = prisma.product.findFirst.mock.calls[0][0];
      expect(call.where.id).toBe(PRODUCT_ID);
      expect(call.where.store.status.in).toEqual(
        expect.arrayContaining(['approved']),
      );
    });

    it('returns the product when the store is approved', async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
        name: 'Roses',
        price: 100,
        imageUrl: null,
        category: 'flowers',
        isFastDelivery: true,
        sourceType: 'manual',
        externalProductId: null,
        stockStatus: 'in_stock',
        isAvailable: true,
        lastSyncedAt: null,
        createdAt: new Date(),
        images: [],
        wishlistedByCount: 0,
        giftedByCount: 0,
        trendingAt: null,
        store: { metricsVisibility: null },
      });

      const out = await service.findOne(PRODUCT_ID);
      expect(out.id).toBe(PRODUCT_ID);
    });
  });

  describe('checkAvailability (Order + Gift entry point)', () => {
    it('returns null when no productId is supplied (legacy / sample path)', async () => {
      const out = await service.checkAvailability(null);
      expect(out).toBeNull();
      expect(prisma.product.findUnique).not.toHaveBeenCalled();
    });

    it("throws when the product's parent store is suspended", async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
        isAvailable: true,
        stockStatus: 'in_stock',
        store: { status: 'suspended' },
      });

      await expect(
        service.checkAvailability(PRODUCT_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws when the product's parent store is rejected", async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
        isAvailable: true,
        stockStatus: 'in_stock',
        store: { status: 'rejected' },
      });

      await expect(
        service.checkAvailability(PRODUCT_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws when the product's parent store is draft", async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
        isAvailable: true,
        stockStatus: 'in_stock',
        store: { status: 'draft' },
      });

      await expect(
        service.checkAvailability(PRODUCT_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns the product when the store is approved', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
        isAvailable: true,
        stockStatus: 'in_stock',
        store: { status: 'approved' },
      });

      const out = await service.checkAvailability(PRODUCT_ID);
      expect(out).not.toBeNull();
      expect(out?.id).toBe(PRODUCT_ID);
      // Wire shape stays narrow — `store` join is stripped from the
      // return value so downstream callers (OrdersService,
      // GiftsService) see the same fields they always did.
      expect((out as unknown as { store?: unknown }).store).toBeUndefined();
    });

    it('still rejects on the existing "out of stock" branch (regression guard)', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
        isAvailable: true,
        stockStatus: 'out_of_stock',
        store: { status: 'approved' },
      });

      await expect(
        service.checkAvailability(PRODUCT_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
