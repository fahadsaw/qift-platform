// Wishlist purchase fulfillment hook tests on GiftsService.
//
// Targets the two architectural rules in
// `project_wishlist_purchase_fulfillment.md`:
//   - On gift create with productId, the receiver's matching
//     wishlist row gets soft-deactivated (deactivatedReason =
//     'purchased_for_recipient').
//   - On gift cancel, the receiver's matching wishlist row
//     un-deactivates if it carries the fulfillment reason.
//
// We mock PrismaService directly so we can assert the exact
// updateMany calls. Other GiftsService side effects
// (notifications, transition validation) are out of scope here —
// we exercise the hook surface via a minimal fixture path.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { GiftsService } from './gifts.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

type MockPrisma = {
  user: { findUnique: jest.Mock; findFirst: jest.Mock };
  gift: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  giftAttempt: { create: jest.Mock; findFirst: jest.Mock };
  address: { count: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock };
  wish: { updateMany: jest.Mock };
  giftPost: { updateMany: jest.Mock };
  store: { findUnique: jest.Mock };
  product: { findUnique: jest.Mock };
};

function createPrismaMock(): MockPrisma {
  return {
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    gift: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    giftAttempt: { create: jest.fn(), findFirst: jest.fn() },
    address: {
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    wish: { updateMany: jest.fn() },
    // GiftPost cancel-cascade hook. Each cancel test sets a return
    // value so the count assertion can verify whether the row was
    // touched. Default `count: 0` means "no published post for this
    // gift" — the legacy / no-product cancel path.
    giftPost: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    store: { findUnique: jest.fn() },
    product: { findUnique: jest.fn() },
  };
}

const SENDER_ID = 'user_sender';
const RECEIVER_ID = 'user_receiver';
const PRODUCT_ID = 'prod_riyadh_flowers';
const STORE_ID = 'store_riyadh_flowers';

describe('GiftsService — wishlist purchase fulfillment hook', () => {
  let service: GiftsService;
  let prisma: MockPrisma;
  let notifications: { trigger: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    notifications = { trigger: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get<GiftsService>(GiftsService);
  });

  describe('create — fulfillment hook', () => {
    function setupHappyPath() {
      // Sender lookup.
      prisma.user.findUnique.mockResolvedValue({
        qiftUsername: 'sender_handle',
      });
      // Receiver lookup.
      prisma.user.findFirst.mockResolvedValue({ id: RECEIVER_ID });
      // Default address resolver (via `addresses.findFirst` from helper).
      prisma.address.findFirst.mockResolvedValue({ id: 'addr_1' });
      // Product lookup — GiftsService.create gates on availability +
      // stockStatus before persisting. Mock a live in-stock product
      // so the create reaches the wishlist hook.
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        storeId: STORE_ID,
        isAvailable: true,
        stockStatus: 'in_stock',
      });
      // Gift create returns the row with productId.
      prisma.gift.create.mockResolvedValue({
        id: 'gift_1',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        status: 'pending_address',
        sender: {
          id: SENDER_ID,
          qiftUsername: 'sender_handle',
          fullName: null,
        },
        receiver: {
          id: RECEIVER_ID,
          qiftUsername: 'receiver_handle',
          fullName: null,
        },
        address: null,
      });
      prisma.wish.updateMany.mockResolvedValue({ count: 1 });
    }

    it("soft-deactivates the receiver's matching wishlist row", async () => {
      setupHappyPath();

      await service.create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
          productId: PRODUCT_ID,
          storeId: STORE_ID,
        },
        SENDER_ID,
      );

      // Exactly one wish.updateMany call with the fulfillment reason.
      expect(prisma.wish.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: RECEIVER_ID,
            productId: PRODUCT_ID,
            deactivatedAt: null,
          }),
          data: expect.objectContaining({
            deactivatedAt: expect.any(Date),
            deactivatedReason: 'purchased_for_recipient',
          }),
        }),
      );
    });

    it('idempotent — second simultaneous gift no-ops because deactivatedAt IS NULL guard misses', async () => {
      setupHappyPath();
      // Simulate the "second sender" scenario: updateMany matches 0
      // because the first sender's gift already deactivated the row.
      prisma.wish.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
          productId: PRODUCT_ID,
        },
        SENDER_ID,
      );

      // The call STILL happens (Prisma's updateMany doesn't know it
      // matched zero rows in advance) — the database does the
      // race-safety via the deactivatedAt: null filter.
      expect(prisma.wish.updateMany).toHaveBeenCalledTimes(1);
    });

    it('skips the hook when gift has no productId (legacy / sample)', async () => {
      // Receiver lookup + sender + gift create with productId null.
      prisma.user.findUnique.mockResolvedValue({
        qiftUsername: 'sender_handle',
      });
      prisma.user.findFirst.mockResolvedValue({ id: RECEIVER_ID });
      prisma.address.findFirst.mockResolvedValue({ id: 'addr_1' });
      prisma.gift.create.mockResolvedValue({
        id: 'gift_legacy',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
        productName: 'something free-text',
        storeName: 'some store',
        productId: null,
        storeId: null,
        status: 'pending_address',
        sender: {
          id: SENDER_ID,
          qiftUsername: 'sender_handle',
          fullName: null,
        },
        receiver: {
          id: RECEIVER_ID,
          qiftUsername: 'receiver_handle',
          fullName: null,
        },
        address: null,
      });

      await service.create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'something free-text',
          storeName: 'some store',
          // No productId.
        },
        SENDER_ID,
      );

      expect(prisma.wish.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT block gift creation if the fulfillment hook fails', async () => {
      setupHappyPath();
      // Simulate a DB error on the wishlist hook only.
      prisma.wish.updateMany.mockRejectedValueOnce(new Error('boom'));

      const result = await service.create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
          productId: PRODUCT_ID,
        },
        SENDER_ID,
      );

      // Gift creation still succeeded — fulfillment hook is non-fatal.
      expect(result).toBeDefined();
      // Receiver still gets the gift-received notification.
      expect(notifications.trigger).toHaveBeenCalled();
    });

    it('privacy: hook payload never carries buyer identity or giftId', async () => {
      setupHappyPath();

      await service.create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
          productId: PRODUCT_ID,
        },
        SENDER_ID,
      );

      const call = prisma.wish.updateMany.mock.calls[0][0];
      // The `where` is keyed on (userId=receiver, productId) — no
      // sender id, no gift id leaks into the wish row at all.
      expect(call.where).not.toHaveProperty('senderId');
      expect(call.where).not.toHaveProperty('giftId');
      // The `data` carries the deactivation flags ONLY — no
      // fulfilledByGiftId, no buyerId.
      expect(Object.keys(call.data).sort()).toEqual(
        ['deactivatedAt', 'deactivatedReason'].sort(),
      );
    });
  });

  describe('cancel — un-fulfillment hook', () => {
    function setupCancellableGift() {
      // gift.findUnique returns a cancellable row WITH productId.
      prisma.gift.findUnique.mockResolvedValue({
        id: 'gift_1',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        status: 'pending_address',
        sender: {
          id: SENDER_ID,
          qiftUsername: 'sender_handle',
          fullName: null,
        },
        receiver: {
          id: RECEIVER_ID,
          qiftUsername: 'receiver_handle',
          fullName: null,
        },
        address: null,
      });
      // updateMany on gift status flip returns count=1.
      prisma.gift.updateMany.mockResolvedValue({ count: 1 });
      // gift.findUnique called again post-update for the response.
      prisma.gift.findUnique.mockResolvedValueOnce({
        id: 'gift_1',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        status: 'pending_address',
        sender: {
          id: SENDER_ID,
          qiftUsername: 'sender_handle',
          fullName: null,
        },
        receiver: {
          id: RECEIVER_ID,
          qiftUsername: 'receiver_handle',
          fullName: null,
        },
        address: null,
      });
      prisma.wish.updateMany.mockResolvedValue({ count: 1 });
    }

    it('reverses the fulfillment on cancel', async () => {
      setupCancellableGift();

      await service.cancel('gift_1', SENDER_ID);

      // Two updateMany calls happened during this test:
      //   1. Gift status flip to 'cancelled'
      //   2. Wishlist un-fulfillment
      // We assert the wish call specifically by matching its shape.
      const wishCalls = prisma.wish.updateMany.mock.calls;
      expect(wishCalls.length).toBe(1);
      expect(wishCalls[0][0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: RECEIVER_ID,
            productId: PRODUCT_ID,
            deactivatedReason: 'purchased_for_recipient',
          }),
          data: expect.objectContaining({
            deactivatedAt: null,
            deactivatedReason: null,
          }),
        }),
      );
    });

    it('skips the hook when the cancelled gift had no productId', async () => {
      prisma.gift.findUnique.mockResolvedValue({
        id: 'gift_legacy',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
        productName: 'free-text',
        storeName: null,
        productId: null,
        storeId: null,
        status: 'pending_address',
        sender: {
          id: SENDER_ID,
          qiftUsername: 'sender_handle',
          fullName: null,
        },
        receiver: {
          id: RECEIVER_ID,
          qiftUsername: 'receiver_handle',
          fullName: null,
        },
        address: null,
      });
      prisma.gift.updateMany.mockResolvedValue({ count: 1 });
      prisma.gift.findUnique.mockResolvedValueOnce({
        id: 'gift_legacy',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
        productName: 'free-text',
        storeName: null,
        productId: null,
        storeId: null,
        status: 'pending_address',
        sender: {
          id: SENDER_ID,
          qiftUsername: 'sender_handle',
          fullName: null,
        },
        receiver: {
          id: RECEIVER_ID,
          qiftUsername: 'receiver_handle',
          fullName: null,
        },
        address: null,
      });

      await service.cancel('gift_legacy', SENDER_ID);

      expect(prisma.wish.updateMany).not.toHaveBeenCalled();
    });

    it('soft-deactivates any published GiftPost for the cancelled gift', async () => {
      setupCancellableGift();
      // Pretend a published post exists for this gift — the cascade
      // hook should match it and the updateMany returns count=1.
      prisma.giftPost.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel('gift_1', SENDER_ID);

      expect(prisma.giftPost.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.giftPost.updateMany.mock.calls[0][0];
      // Privacy + correctness: the cascade matches strictly on
      // (giftId, deactivatedAt: null) so a previously-deactivated
      // post is not touched, and only the published post for THIS
      // specific gift is affected — no cross-user collateral.
      expect(call.where).toEqual({ giftId: 'gift_1', deactivatedAt: null });
      // Reason is the operator-visible breadcrumb; never carries
      // buyer identity or the cancelling user id.
      expect(call.data).toEqual({
        deactivatedAt: expect.any(Date),
        deactivatedReason: 'gift_cancelled',
      });
    });

    it('does not block the cancel when the GiftPost cascade fails', async () => {
      setupCancellableGift();
      prisma.giftPost.updateMany.mockRejectedValue(
        new Error('db down for this hook'),
      );

      // Cancel still succeeds end-to-end — the hook is best-effort.
      await expect(service.cancel('gift_1', SENDER_ID)).resolves.toBeDefined();
    });
  });
});
