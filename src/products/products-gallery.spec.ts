// Phase 2.5a — ProductsService gallery + video sync specs.
//
// Three behaviour invariants are pinned here:
//
//   1. imageUrls (new) takes precedence over imageUrl (legacy)
//      for the denormalised primary image column, so a client
//      posting both gets predictable results (the gallery is
//      the new source of truth).
//
//   2. update() replaces the existing ProductImage gallery in
//      one transaction (deleteMany → createMany), keeps the
//      legacy imageUrl column in sync with imageUrls[0], and
//      rejects malformed input BEFORE touching the DB.
//
//   3. The (videoUrl, videoType) pair must be both-or-neither.
//      A half-defined video reference can never be persisted.
//
// We mock PrismaService at the method level. No real DB. The
// store-ownership check is short-circuited by stubbing
// StoresService.assertOwner.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from '../stores/stores.service';

const STORE_ID = 'store_1';
const PRODUCT_ID = 'prod_1';
const VIEWER_ID = 'user_owner';

function makeRawProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    storeId: STORE_ID,
    name: 'Eau de Parfum',
    price: 100,
    imageUrl: null,
    videoUrl: null,
    videoType: null,
    category: 'perfume',
    isFastDelivery: false,
    sourceType: 'manual',
    externalProductId: null,
    stockStatus: 'in_stock',
    isAvailable: true,
    lastSyncedAt: null,
    createdAt: new Date(),
    images: [] as Array<{
      url: string;
      displayOrder: number;
      imageMeta: unknown;
    }>,
    wishlistedByCount: 0,
    giftedByCount: 0,
    trendingAt: null,
    ...overrides,
  };
}

function makePrismaMock() {
  const productCreate = jest.fn();
  const productUpdate = jest.fn();
  const productFindUnique = jest.fn();
  const storeFindUnique = jest
    .fn()
    .mockResolvedValue({ metricsVisibility: null });
  const productImageDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const productImageCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const $transaction = jest
    .fn()
    .mockImplementation(
      async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
        cb({
          productImage: {
            deleteMany: productImageDeleteMany,
            createMany: productImageCreateMany,
          },
          product: {
            update: productUpdate,
          },
        }),
    );
  return {
    product: {
      create: productCreate,
      update: productUpdate,
      findUnique: productFindUnique,
    },
    productImage: {
      deleteMany: productImageDeleteMany,
      createMany: productImageCreateMany,
    },
    store: {
      findUnique: storeFindUnique,
    },
    $transaction,
    // Surfaced for tests that want to assert per-method invocation
    // counts on the transactional methods.
    _productImageDeleteMany: productImageDeleteMany,
    _productImageCreateMany: productImageCreateMany,
  };
}

describe('ProductsService — Phase 2.5a gallery + video', () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let stores: { assertOwner: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    stores = {
      assertOwner: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StoresService, useValue: stores },
      ],
    }).compile();
    service = module.get<ProductsService>(ProductsService);
  });

  describe('create — gallery precedence + ProductImage nested write', () => {
    it('writes ProductImage rows in order when imageUrls is provided', async () => {
      prisma.product.create.mockResolvedValueOnce(
        makeRawProduct({
          imageUrl: 'https://r2.qift/p1.jpg',
          images: [
            { url: 'https://r2.qift/p1.jpg', displayOrder: 0, imageMeta: null },
            { url: 'https://r2.qift/p2.jpg', displayOrder: 1, imageMeta: null },
          ],
        }),
      );
      await service.create(VIEWER_ID, {
        storeId: STORE_ID,
        name: 'Eau de Parfum',
        category: 'perfume',
        price: 100,
        imageUrls: ['https://r2.qift/p1.jpg', 'https://r2.qift/p2.jpg'],
      });
      const data = prisma.product.create.mock.calls[0][0].data;
      expect(data.images).toEqual({
        create: [
          { url: 'https://r2.qift/p1.jpg', displayOrder: 0 },
          { url: 'https://r2.qift/p2.jpg', displayOrder: 1 },
        ],
      });
    });

    it('denormalises imageUrl from imageUrls[0]', async () => {
      prisma.product.create.mockResolvedValueOnce(makeRawProduct());
      await service.create(VIEWER_ID, {
        storeId: STORE_ID,
        name: 'Eau de Parfum',
        category: 'perfume',
        price: 100,
        imageUrls: ['https://r2.qift/primary.jpg', 'https://r2.qift/alt.jpg'],
      });
      const data = prisma.product.create.mock.calls[0][0].data;
      expect(data.imageUrl).toBe('https://r2.qift/primary.jpg');
    });

    it('imageUrls[0] wins when both imageUrl and imageUrls are sent', async () => {
      // Predictable precedence: the gallery is the new source of
      // truth, so its primary wins over the legacy single field.
      prisma.product.create.mockResolvedValueOnce(makeRawProduct());
      await service.create(VIEWER_ID, {
        storeId: STORE_ID,
        name: 'Eau de Parfum',
        category: 'perfume',
        price: 100,
        imageUrl: 'https://r2.qift/legacy.jpg',
        imageUrls: ['https://r2.qift/gallery-primary.jpg'],
      });
      const data = prisma.product.create.mock.calls[0][0].data;
      expect(data.imageUrl).toBe('https://r2.qift/gallery-primary.jpg');
    });

    it('legacy imageUrl path still works when imageUrls is omitted', async () => {
      // Backwards compat: a caller that knows nothing about
      // imageUrls (legacy ProductModal, external integration)
      // continues to get the URL-paste flow.
      prisma.product.create.mockResolvedValueOnce(makeRawProduct());
      await service.create(VIEWER_ID, {
        storeId: STORE_ID,
        name: 'Eau de Parfum',
        category: 'perfume',
        price: 100,
        imageUrl: 'https://example.com/legacy.jpg',
      });
      const data = prisma.product.create.mock.calls[0][0].data;
      expect(data.imageUrl).toBe('https://example.com/legacy.jpg');
      expect(data.images).toBeUndefined();
    });

    it('rejects non-http URLs in imageUrls', async () => {
      await expect(
        service.create(VIEWER_ID, {
          storeId: STORE_ID,
          name: 'Eau de Parfum',
          category: 'perfume',
          price: 100,
          imageUrls: ['javascript:alert(1)'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Defensive: a malformed URL must NEVER reach the create
      // call. Validation runs strictly before any DB write.
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('rejects imageUrls arrays larger than the cap', async () => {
      const too_many = Array.from(
        { length: 9 },
        (_, i) => `https://r2.qift/p${i}.jpg`,
      );
      await expect(
        service.create(VIEWER_ID, {
          storeId: STORE_ID,
          name: 'Eau de Parfum',
          category: 'perfume',
          price: 100,
          imageUrls: too_many,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('deduplicates duplicate URLs while preserving order', async () => {
      prisma.product.create.mockResolvedValueOnce(makeRawProduct());
      await service.create(VIEWER_ID, {
        storeId: STORE_ID,
        name: 'Eau de Parfum',
        category: 'perfume',
        price: 100,
        imageUrls: [
          'https://r2.qift/a.jpg',
          'https://r2.qift/b.jpg',
          'https://r2.qift/a.jpg', // duplicate — dropped
        ],
      });
      const data = prisma.product.create.mock.calls[0][0].data;
      expect(data.images.create).toEqual([
        { url: 'https://r2.qift/a.jpg', displayOrder: 0 },
        { url: 'https://r2.qift/b.jpg', displayOrder: 1 },
      ]);
    });

    it('writes videoUrl + videoType together', async () => {
      prisma.product.create.mockResolvedValueOnce(makeRawProduct());
      await service.create(VIEWER_ID, {
        storeId: STORE_ID,
        name: 'Eau de Parfum',
        category: 'perfume',
        price: 100,
        videoUrl: 'https://r2.qift/v1.mp4',
        videoType: 'mp4',
      });
      const data = prisma.product.create.mock.calls[0][0].data;
      expect(data.videoUrl).toBe('https://r2.qift/v1.mp4');
      expect(data.videoType).toBe('mp4');
    });

    it('rejects videoUrl without videoType', async () => {
      await expect(
        service.create(VIEWER_ID, {
          storeId: STORE_ID,
          name: 'Eau de Parfum',
          category: 'perfume',
          price: 100,
          videoUrl: 'https://r2.qift/v.mp4',
          // videoType missing
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('rejects videoType without videoUrl', async () => {
      await expect(
        service.create(VIEWER_ID, {
          storeId: STORE_ID,
          name: 'Eau de Parfum',
          category: 'perfume',
          price: 100,
          videoType: 'mp4',
          // videoUrl missing
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });
  });

  describe('update — gallery replace transactionally', () => {
    beforeEach(() => {
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
      });
    });

    it('replaces the gallery by deleteMany + createMany on the transaction', async () => {
      prisma.product.update.mockResolvedValueOnce(makeRawProduct());
      await service.update(VIEWER_ID, PRODUCT_ID, {
        imageUrls: ['https://r2.qift/new1.jpg', 'https://r2.qift/new2.jpg'],
      });
      expect(prisma._productImageDeleteMany).toHaveBeenCalledWith({
        where: { productId: PRODUCT_ID },
      });
      expect(prisma._productImageCreateMany).toHaveBeenCalledWith({
        data: [
          {
            productId: PRODUCT_ID,
            url: 'https://r2.qift/new1.jpg',
            displayOrder: 0,
          },
          {
            productId: PRODUCT_ID,
            url: 'https://r2.qift/new2.jpg',
            displayOrder: 1,
          },
        ],
      });
    });

    it('passing an EMPTY imageUrls array clears the gallery + imageUrl', async () => {
      prisma.product.update.mockResolvedValueOnce(makeRawProduct());
      await service.update(VIEWER_ID, PRODUCT_ID, {
        imageUrls: [],
      });
      // deleteMany still runs (caller signalled "clear it");
      // createMany does NOT run (nothing to create).
      expect(prisma._productImageDeleteMany).toHaveBeenCalledTimes(1);
      expect(prisma._productImageCreateMany).not.toHaveBeenCalled();
      const updateCall = prisma.product.update.mock.calls[0][0];
      expect(updateCall.data.imageUrl).toBeNull();
    });

    it('passing imageUrls UNDEFINED leaves the gallery untouched (PATCH semantics)', async () => {
      prisma.product.update.mockResolvedValueOnce(makeRawProduct());
      await service.update(VIEWER_ID, PRODUCT_ID, {
        // no imageUrls — only updating the name
        name: 'Renamed product',
      });
      expect(prisma._productImageDeleteMany).not.toHaveBeenCalled();
      expect(prisma._productImageCreateMany).not.toHaveBeenCalled();
      const updateCall = prisma.product.update.mock.calls[0][0];
      // legacy imageUrl ALSO untouched
      expect('imageUrl' in updateCall.data).toBe(false);
    });

    it('imageUrls[0] denormalises onto Product.imageUrl in the update payload', async () => {
      prisma.product.update.mockResolvedValueOnce(makeRawProduct());
      await service.update(VIEWER_ID, PRODUCT_ID, {
        imageUrls: ['https://r2.qift/new-primary.jpg'],
      });
      const updateCall = prisma.product.update.mock.calls[0][0];
      expect(updateCall.data.imageUrl).toBe('https://r2.qift/new-primary.jpg');
    });

    it('legacy imageUrl=null clears the column without touching the gallery', async () => {
      // Backwards compat: callers that only know about imageUrl
      // can still clear it. The gallery is NOT cleared (that
      // would be a destructive surprise for clients that don't
      // know about ProductImage).
      prisma.product.update.mockResolvedValueOnce(makeRawProduct());
      await service.update(VIEWER_ID, PRODUCT_ID, {
        imageUrl: null,
      });
      const updateCall = prisma.product.update.mock.calls[0][0];
      expect(updateCall.data.imageUrl).toBeNull();
      expect(prisma._productImageDeleteMany).not.toHaveBeenCalled();
      expect(prisma._productImageCreateMany).not.toHaveBeenCalled();
    });
  });
});
