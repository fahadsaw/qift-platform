// Wishlist purchase-fulfillment + first-class behavior tests.
//
// Verifies the architectural rules captured in:
//   - project_wishlist_purchase_fulfillment.md
//   - project_unified_heart_state.md
//   - project_wishlist_first_class.md
//
// We mock PrismaService directly rather than spin up a real DB.
// The behavior under test is upsert semantics + denormalized
// counter writes, both of which are deterministic Prisma calls.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WishesService } from './wishes.service';
import { PrismaService } from '../prisma/prisma.service';

// Minimal Prisma mock. Each method we touch returns a configurable
// fixture. `wishUpsert.mockResolvedValue(...)` per-test.
type MockPrisma = {
  product: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  wish: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
};

function createPrismaMock(): MockPrisma {
  return {
    product: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    wish: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

describe('WishesService', () => {
  let service: WishesService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [WishesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<WishesService>(WishesService);
  });

  describe('create — product-linked path', () => {
    const userId = 'user_receiver';
    const productId = 'prod_riyadh_flowers';
    const storeId = 'store_riyadh_flowers';

    const liveProduct = {
      id: productId,
      name: 'باقة جوري',
      imageUrl: 'https://r2.qift.app/products/123.jpg',
      price: 250,
      storeId,
      store: { id: storeId, name: 'باقات الرياض' },
    };

    const baseWishRow = {
      id: 'wish_1',
      title: 'باقة جوري',
      store: 'باقات الرياض',
      productId,
      storeId,
      productName: 'باقة جوري',
      storeName: 'باقات الرياض',
      imageUrl: liveProduct.imageUrl,
      price: 250,
      currency: 'SAR',
      visibility: 'public',
      deactivatedAt: null,
      deactivatedReason: null,
      createdAt: new Date(),
    };

    it('creates a new wish + bumps Product.wishlistedByCount on first heart', async () => {
      prisma.product.findUnique.mockResolvedValue(liveProduct);
      prisma.wish.findUnique.mockResolvedValue(null); // No existing row
      prisma.wish.upsert.mockResolvedValue(baseWishRow);
      // Counter increment: returns the post-increment value so
      // the trending-heart-velocity check sees a real number.
      // Below the TRENDING_HEART_THRESHOLD, so trendingAt does
      // NOT get bumped (asserted below).
      prisma.product.update.mockResolvedValue({ wishlistedByCount: 1 });

      const result = await service.create(userId, { productId });

      // Resolved live product (snapshot reconciliation).
      expect(prisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: productId },
        select: expect.any(Object),
      });
      // Upsert keyed on (userId, productId).
      expect(prisma.wish.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_productId: { userId, productId } },
        }),
      );
      // Counter bumped (this was a fresh heart). The `select`
      // arg was added in Phase 5 so the service can read the
      // post-increment value and decide whether to bump the
      // trending timestamp.
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: productId },
        data: { wishlistedByCount: { increment: 1 } },
        select: { wishlistedByCount: true },
      });
      // Below TRENDING_HEART_THRESHOLD (3) — trendingAt MUST
      // NOT be bumped on the first heart. The wishlist increment
      // was the ONLY product.update call.
      expect(prisma.product.update).toHaveBeenCalledTimes(1);
      expect(result).toEqual(baseWishRow);
    });

    it('bumps trendingAt once the heart-velocity threshold is crossed', async () => {
      // Same flow as above but the mock returns a post-increment
      // count of 3 (== TRENDING_HEART_THRESHOLD) so the service
      // fires a SECOND product.update setting trendingAt = now.
      prisma.product.findUnique.mockResolvedValue(liveProduct);
      prisma.wish.findUnique.mockResolvedValue(null);
      prisma.wish.upsert.mockResolvedValue(baseWishRow);
      prisma.product.update.mockResolvedValue({ wishlistedByCount: 3 });

      await service.create(userId, { productId });

      // Two updates: the counter increment, then the trending
      // timestamp. Order matters — counter first so the read
      // shows the post-increment value.
      expect(prisma.product.update).toHaveBeenCalledTimes(2);
      expect(prisma.product.update).toHaveBeenNthCalledWith(1, {
        where: { id: productId },
        data: { wishlistedByCount: { increment: 1 } },
        select: { wishlistedByCount: true },
      });
      const second = prisma.product.update.mock.calls[1][0] as {
        where: { id: string };
        data: { trendingAt: unknown };
      };
      expect(second.where).toEqual({ id: productId });
      expect(second.data.trendingAt).toBeInstanceOf(Date);
    });

    it('re-heart does NOT bump the counter again', async () => {
      prisma.product.findUnique.mockResolvedValue(liveProduct);
      // Existing row → upsert hits update path, not create.
      prisma.wish.findUnique.mockResolvedValue({ id: 'wish_1' });
      prisma.wish.upsert.mockResolvedValue(baseWishRow);

      await service.create(userId, { productId });

      // Counter should NOT bump on update.
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('re-heart clears deactivatedAt + deactivatedReason (un-fulfillment path)', async () => {
      // This is the architectural invariant for purchase-fulfillment
      // reversal: when the receiver re-hearts a product whose row was
      // soft-deactivated by a gift purchase, the upsert's `update`
      // branch wipes both fields so the heart goes back to ❤️.
      prisma.product.findUnique.mockResolvedValue(liveProduct);
      prisma.wish.findUnique.mockResolvedValue({ id: 'wish_1' });
      prisma.wish.upsert.mockResolvedValue({
        ...baseWishRow,
        deactivatedAt: null,
        deactivatedReason: null,
      });

      await service.create(userId, { productId });

      expect(prisma.wish.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            deactivatedAt: null,
            deactivatedReason: null,
          }),
        }),
      );
    });

    it('refreshes the snapshot on re-heart so wishlist card reflects latest product', async () => {
      const updatedProduct = {
        ...liveProduct,
        name: 'باقة جوري (تشكيلة جديدة)',
        price: 290,
      };
      prisma.product.findUnique.mockResolvedValue(updatedProduct);
      prisma.wish.findUnique.mockResolvedValue({ id: 'wish_1' });
      prisma.wish.upsert.mockResolvedValue(baseWishRow);

      await service.create(userId, { productId });

      expect(prisma.wish.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            productName: 'باقة جوري (تشكيلة جديدة)',
            price: 290,
          }),
        }),
      );
    });

    it('throws NotFoundException when productId does not resolve', async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.create(userId, { productId })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does NOT overwrite visibility on re-heart (user may have privatized)', async () => {
      prisma.product.findUnique.mockResolvedValue(liveProduct);
      prisma.wish.findUnique.mockResolvedValue({ id: 'wish_1' });
      prisma.wish.upsert.mockResolvedValue(baseWishRow);

      await service.create(userId, { productId, visibility: 'public' });

      const upsertCall = prisma.wish.upsert.mock.calls[0][0];
      // Visibility is set on `create` (initial heart) but NOT in the
      // `update` branch — privatizing afterwards must persist.
      expect(upsertCall.update).not.toHaveProperty('visibility');
    });
  });

  describe('create — legacy free-text path', () => {
    const userId = 'user_a';

    it('inserts a free-text wish when no productId', async () => {
      prisma.wish.findFirst.mockResolvedValue(null);
      prisma.wish.create.mockResolvedValue({
        id: 'wish_legacy_1',
        title: 'Random gift idea',
        store: null,
        productId: null,
        storeId: null,
        productName: null,
        storeName: null,
        imageUrl: null,
        price: null,
        currency: null,
        visibility: 'public',
        deactivatedAt: null,
        deactivatedReason: null,
        createdAt: new Date(),
      });

      await service.create(userId, { title: 'Random gift idea' });

      expect(prisma.wish.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId,
            title: 'Random gift idea',
            store: null,
            visibility: 'public',
          }),
        }),
      );
      // No product counter touch on legacy path.
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('returns existing row on idempotent (title, store) match', async () => {
      const existing = {
        id: 'wish_legacy_existing',
        title: 'Random',
        store: null,
        productId: null,
      };
      prisma.wish.findFirst.mockResolvedValue(existing);

      const result = await service.create(userId, { title: 'Random' });

      expect(result).toEqual(existing);
      expect(prisma.wish.create).not.toHaveBeenCalled();
    });

    it('rejects empty title', async () => {
      await expect(service.create(userId, { title: '   ' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('removeByProduct — symmetric unheart', () => {
    const userId = 'user_a';
    const productId = 'prod_1';

    it('decrements the product counter on real unheart', async () => {
      prisma.wish.findUnique.mockResolvedValue({ id: 'wish_1' });
      prisma.wish.delete.mockResolvedValue({});
      prisma.product.update.mockResolvedValue({});

      const result = await service.removeByProduct(userId, productId);

      expect(prisma.wish.delete).toHaveBeenCalledWith({
        where: { id: 'wish_1' },
      });
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: productId },
        data: { wishlistedByCount: { decrement: 1 } },
      });
      expect(result).toEqual({ ok: true });
    });

    it('is idempotent — returns ok when product was not wishlisted', async () => {
      prisma.wish.findUnique.mockResolvedValue(null);

      const result = await service.removeByProduct(userId, productId);

      expect(result).toEqual({ ok: true });
      expect(prisma.wish.delete).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });

  describe('remove — owner-only by wish id', () => {
    const userId = 'user_a';

    it('decrements counter when row had a productId', async () => {
      prisma.wish.findFirst.mockResolvedValue({
        id: 'w1',
        productId: 'prod_1',
      });
      prisma.wish.delete.mockResolvedValue({});
      prisma.product.update.mockResolvedValue({});

      await service.remove(userId, 'w1');

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'prod_1' },
        data: { wishlistedByCount: { decrement: 1 } },
      });
    });

    it('skips counter when row is legacy (productId null)', async () => {
      prisma.wish.findFirst.mockResolvedValue({
        id: 'w1',
        productId: null,
      });
      prisma.wish.delete.mockResolvedValue({});

      await service.remove(userId, 'w1');

      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('404s when wish does not belong to the caller', async () => {
      prisma.wish.findFirst.mockResolvedValue(null);
      await expect(service.remove(userId, 'w1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('checkMembership', () => {
    const userId = 'user_a';
    const productId = 'prod_1';

    it('returns inWishlist=true with wishId when row exists', async () => {
      prisma.wish.findUnique.mockResolvedValue({ id: 'w1' });
      const result = await service.checkMembership(userId, productId);
      expect(result).toEqual({ inWishlist: true, wishId: 'w1' });
    });

    it('returns inWishlist=false when no row', async () => {
      prisma.wish.findUnique.mockResolvedValue(null);
      const result = await service.checkMembership(userId, productId);
      expect(result).toEqual({ inWishlist: false });
    });

    it('returns false for empty productId without hitting the DB', async () => {
      const result = await service.checkMembership(userId, '');
      expect(result).toEqual({ inWishlist: false });
      expect(prisma.wish.findUnique).not.toHaveBeenCalled();
    });
  });
});
