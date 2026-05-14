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
  // Phase 6.4 — occasion attach validation. The Gift.create path
  // calls findFirst against this table only when the caller passes
  // body.occasionId; legacy tests (no attach) leave the mock unset.
  occasion: { findFirst: jest.Mock };
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
    // Phase 6.4. Defaults to "not found" — the legacy create-path
    // tests pass nothing, so the lookup is never invoked; the
    // occasion-attach tests below override per case.
    occasion: { findFirst: jest.fn().mockResolvedValue(null) },
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

    describe('surprise-mode privacy on cancellation notification', () => {
      // A cancelled surprise gift NEVER resolves the surprise — the
      // receiver doesn't get to see the product. The cancellation
      // notification body must therefore NOT leak productName via
      // the push pipeline. The title stays generic (ar: "تم إلغاء
      // الهدية" — "Your gift was cancelled") so the receiver still
      // knows what happened without learning what it was.

      function surpriseCancellableGift(isSurprise: boolean) {
        // Both findUnique calls in cancel() return the same shape;
        // the helper composes the notification body from the FIRST
        // (pre-update) read, so status='pending_address' is what
        // matters for routing. Mirror the same shape on the default
        // and the post-update read to avoid a stale-state surprise
        // inside the test setup.
        const giftRow = {
          id: 'gift_surprise',
          senderId: SENDER_ID,
          receiverId: RECEIVER_ID,
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
          productId: PRODUCT_ID,
          storeId: STORE_ID,
          status: 'pending_address',
          isSurprise,
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
        };
        prisma.gift.findUnique.mockResolvedValue(giftRow);
        prisma.gift.updateMany.mockResolvedValue({ count: 1 });
      }

      it('masks productName in the receiver cancellation body when isSurprise=true', async () => {
        surpriseCancellableGift(true);
        await service.cancel('gift_surprise', SENDER_ID);

        // The receiver gets exactly one notification (cancellation).
        // The sender does NOT get one — they performed the action.
        expect(notifications.trigger).toHaveBeenCalledTimes(1);
        const call = notifications.trigger.mock.calls[0][0];
        expect(call.userId).toBe(RECEIVER_ID);
        expect(call.type).toBe('gift.cancelled');
        // Title is generic — no product leak.
        expect(call.title).not.toContain('باقة جوري');
        // CRITICAL: body must be null on surprise cancellation.
        // This is the surprise-privacy invariant — a surprise that
        // never resolved (because it was cancelled) must not leak
        // the product via the cancellation push.
        expect(call.body).toBeNull();
      });

      it('reveals productName in the receiver cancellation body when isSurprise=false', async () => {
        // Baseline: non-surprise gifts continue to render productName
        // in the cancellation body (the receiver already saw it on
        // the initial GiftReceived notification — no new leak).
        surpriseCancellableGift(false);
        await service.cancel('gift_surprise', SENDER_ID);

        const call = notifications.trigger.mock.calls[0][0];
        expect(call.userId).toBe(RECEIVER_ID);
        expect(call.body).toBe('باقة جوري');
      });
    });
  });
});

// Phase 6.4 — gifting-context occasion attach. The Gift.create path
// accepts an optional `occasionId` and validates it against the
// (sender, receiver, owner) shape. These tests cover the three
// terminal branches:
//   - sender-owned occasion → persisted
//   - receiver-owned occasion → persisted
//   - any other owner OR soft-deleted → silently dropped (the gift
//     is still created; we never fail a payment for a stale tag)

describe('GiftsService — occasion attach (Phase 6.4)', () => {
  let service: GiftsService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createPrismaMock();
    // Common happy-path fixtures shared across the attach tests.
    prisma.user.findUnique.mockResolvedValue({
      qiftUsername: 'sender_handle',
    });
    prisma.user.findFirst.mockResolvedValue({ id: RECEIVER_ID });
    prisma.address.findFirst.mockResolvedValue({ id: 'addr_1' });
    prisma.gift.create.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve({
        id: 'gift_attach',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
        productName: (data as { productName: string }).productName,
        storeName: (data as { storeName: string }).storeName,
        productId: null,
        storeId: null,
        // Pass through whatever occasionId the service decided to
        // persist so the assertions can read it back.
        occasionId: (data as { occasionId: string | null }).occasionId,
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
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationsService,
          useValue: { trigger: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get<GiftsService>(GiftsService);
  });

  it('persists occasionId when the occasion is owned by the sender', async () => {
    // Sender keeps "remember Sarah's birthday" on their own list.
    // This is the relatedUserId path — the sender's own row tagged
    // with receiver as the celebrated person.
    prisma.occasion.findFirst.mockResolvedValue({
      id: 'occ_sender_owned',
      userId: SENDER_ID,
    });

    await service.create(
      {
        receiverUsername: 'receiver_handle',
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        occasionId: 'occ_sender_owned',
      },
      SENDER_ID,
    );

    const created = prisma.gift.create.mock.calls[0][0];
    expect(created.data.occasionId).toBe('occ_sender_owned');
  });

  it('persists occasionId when the occasion is owned by the receiver', async () => {
    // Receiver's own /occasions list. The picker UI fetched this via
    // /users/:id/occasions (privacy-filtered server-side).
    prisma.occasion.findFirst.mockResolvedValue({
      id: 'occ_receiver_owned',
      userId: RECEIVER_ID,
    });

    await service.create(
      {
        receiverUsername: 'receiver_handle',
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        occasionId: 'occ_receiver_owned',
      },
      SENDER_ID,
    );

    const created = prisma.gift.create.mock.calls[0][0];
    expect(created.data.occasionId).toBe('occ_receiver_owned');
  });

  it('silently drops occasionId when the occasion is owned by a third party', async () => {
    // A malicious client passes an arbitrary occasion id — we drop
    // it. The gift still creates (we never fail a payment over a
    // stale tag) but the Gift.occasionId column ends up null.
    prisma.occasion.findFirst.mockResolvedValue({
      id: 'occ_third_party',
      userId: 'some_other_user',
    });

    await service.create(
      {
        receiverUsername: 'receiver_handle',
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        occasionId: 'occ_third_party',
      },
      SENDER_ID,
    );

    const created = prisma.gift.create.mock.calls[0][0];
    expect(created.data.occasionId).toBeNull();
  });

  it('silently drops occasionId when the occasion is soft-deleted', async () => {
    // The deactivatedAt: null clause in the lookup filters this out,
    // so findFirst returns null — same drop path as the third-party
    // case. (No separate "soft-deleted" branch in service code.)
    prisma.occasion.findFirst.mockResolvedValue(null);

    await service.create(
      {
        receiverUsername: 'receiver_handle',
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        occasionId: 'occ_was_soft_deleted',
      },
      SENDER_ID,
    );

    const created = prisma.gift.create.mock.calls[0][0];
    expect(created.data.occasionId).toBeNull();
  });

  it('skips the occasion lookup entirely when no occasionId is supplied', async () => {
    await service.create(
      {
        receiverUsername: 'receiver_handle',
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
      },
      SENDER_ID,
    );

    // Defence-in-depth: the legacy path must not pay a Prisma round-
    // trip just to ignore an absent occasionId.
    expect(prisma.occasion.findFirst).not.toHaveBeenCalled();
    const created = prisma.gift.create.mock.calls[0][0];
    expect(created.data.occasionId).toBeNull();
  });
});
