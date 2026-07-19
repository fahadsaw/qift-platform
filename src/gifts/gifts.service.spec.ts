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
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GiftsService } from './gifts.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BlocksService } from '../blocks/blocks.service';

type MockPrisma = {
  user: { findUnique: jest.Mock; findFirst: jest.Mock };
  gift: {
    create: jest.Mock;
    findFirst: jest.Mock;
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
      // Week 2 — idempotency pre-check uses findFirst to look up an
      // existing (senderId, idempotencyKey) gift. Default returns
      // null so all existing tests (which pass no idempotency key)
      // pass through the new code path unchanged.
      findFirst: jest.fn().mockResolvedValue(null),
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
        // Week 1 security hardening (F3) — BlocksService is consulted
        // in GiftsService.create before any DB write. Default mock
        // returns `false` so all existing tests (which exercise the
        // happy-path / unrelated-feature code paths) pass through the
        // new block check unchanged. The F3 describe block at the end
        // of this file overrides the mock to true to verify the
        // rejection behaviour.
        {
          provide: BlocksService,
          useValue: {
            isBlockedEitherWay: jest.fn().mockResolvedValue(false),
          },
        },
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
          fulfillmentNumber: 'QF-CANC-TEST',
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
        // CRITICAL: the surprise-privacy invariant survives with the
        // reference attached — a surprise that never resolved must not
        // leak the product via the cancellation push. The body is now
        // EXACTLY the QF reference (Track A.5): quotable, reveals
        // nothing.
        expect(call.body).toBe('QF-CANC-TEST');
        expect(call.body).not.toContain('باقة جوري');
      });

      it('reveals productName in the receiver cancellation body when isSurprise=false', async () => {
        // Baseline: non-surprise gifts continue to render productName
        // in the cancellation body (the receiver already saw it on
        // the initial GiftReceived notification — no new leak).
        surpriseCancellableGift(false);
        await service.cancel('gift_surprise', SENDER_ID);

        const call = notifications.trigger.mock.calls[0][0];
        expect(call.userId).toBe(RECEIVER_ID);
        expect(call.body).toBe('باقة جوري · QF-CANC-TEST');
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
        // Week 1 security hardening (F3) — same default-false mock
        // as the earlier describe block. Lets these tests pass
        // through the new block check unchanged.
        {
          provide: BlocksService,
          useValue: {
            isBlockedEitherWay: jest.fn().mockResolvedValue(false),
          },
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

// ─────────────────────────────────────────────────────────────────────
// Week 1 security hardening — F3 block check on gift creation.
//
// CONTRACT
// GiftsService.create must call BlocksService.isBlockedEitherWay
// before persisting any gift. If either direction of the block
// relationship exists, the create is rejected with
// `ForbiddenException('Recipient unavailable')` — a generic message
// so a probing sender cannot distinguish "blocked" from
// "unreachable".
//
// The bidirectionality of the check (A blocks B OR B blocks A → both
// rejected) is a property of BlocksService.isBlockedEitherWay and is
// covered by that service's own spec. Here we verify GiftsService
// only delegates correctly.
// ─────────────────────────────────────────────────────────────────────

describe('GiftsService — F3 block check on gift creation', () => {
  let service: GiftsService;
  let prisma: MockPrisma;
  let blocks: { isBlockedEitherWay: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    blocks = { isBlockedEitherWay: jest.fn() };

    // Sender lookup — every create() call hits this first.
    prisma.user.findUnique.mockResolvedValue({
      qiftUsername: 'sender_handle',
    });
    // Receiver lookup — resolves to a real user so we proceed past
    // the receiver-not-found gate to the new block check.
    prisma.user.findFirst.mockResolvedValue({ id: RECEIVER_ID });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationsService,
          useValue: { trigger: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: BlocksService, useValue: blocks },
      ],
    }).compile();
    service = module.get<GiftsService>(GiftsService);
  });

  it('throws ForbiddenException("Recipient unavailable") when isBlockedEitherWay returns true', async () => {
    blocks.isBlockedEitherWay.mockResolvedValue(true);

    await expect(
      service.create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
        },
        SENDER_ID,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
        },
        SENDER_ID,
      ),
    ).rejects.toThrow('Recipient unavailable');
  });

  it('passes (senderId, receiverId) to BlocksService.isBlockedEitherWay', async () => {
    blocks.isBlockedEitherWay.mockResolvedValue(true);

    await service
      .create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
        },
        SENDER_ID,
      )
      .catch(() => {
        // expected — we just want to inspect the call arguments
      });

    expect(blocks.isBlockedEitherWay).toHaveBeenCalledWith(
      SENDER_ID,
      RECEIVER_ID,
    );
  });

  it('does NOT persist a Gift row when blocked', async () => {
    blocks.isBlockedEitherWay.mockResolvedValue(true);

    await service
      .create(
        {
          receiverUsername: 'receiver_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
        },
        SENDER_ID,
      )
      .catch(() => {
        // expected
      });

    expect(prisma.gift.create).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit the existing self-send check (regression)', async () => {
    // Self-send must throw BEFORE the block check is reached —
    // the sender and receiver are the same user, so consulting
    // BlocksService.isBlockedEitherWay would be wasteful (and would
    // emit a misleading "blocked-either-way" log line).
    prisma.user.findUnique.mockResolvedValue({
      qiftUsername: 'sender_handle',
    });
    blocks.isBlockedEitherWay.mockResolvedValue(false);

    await expect(
      service.create(
        {
          receiverUsername: 'sender_handle',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
        },
        SENDER_ID,
      ),
    ).rejects.toThrow('لا يمكنك إرسال هدية لنفسك');

    // The self-send guard runs BEFORE the receiver lookup and the
    // block check; neither prisma.user.findFirst nor isBlockedEitherWay
    // should be called.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(blocks.isBlockedEitherWay).not.toHaveBeenCalled();
  });

  it('does NOT call isBlockedEitherWay when the receiver does not exist (NotFound short-circuit)', async () => {
    // Receiver-not-found short-circuits before the block check.
    prisma.user.findFirst.mockResolvedValue(null);
    blocks.isBlockedEitherWay.mockResolvedValue(false);

    await expect(
      service.create(
        {
          receiverUsername: 'ghost_user',
          productName: 'باقة جوري',
          storeName: 'باقات الرياض',
        },
        SENDER_ID,
      ),
    ).rejects.toThrow('Receiver not found');

    expect(blocks.isBlockedEitherWay).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Week 2 — Idempotency on POST /gifts.
//
// CONTRACTS PINNED BY THESE TESTS
//   1. No header → both new columns NULL, returns { replayed: false }
//      (legacy contract preserved verbatim).
//   2. First call with a key → row persists idempotencyKey +
//      idempotencyRequestHash, returns { replayed: false }.
//   3. Retry with same (senderId, key, payload) → returns the
//      original gift with replayed: true; no duplicate insert.
//   4. Retry with same (senderId, key) but DIFFERENT payload →
//      409 ConflictException with code 'idempotency_key_reused'.
//   5. Different senders, same key value → independent (each sender
//      has its own key namespace).
//   6. Concurrent retry: prisma.gift.create rejects with P2002 →
//      service catches, refetches by (senderId, key), returns the
//      winner's gift with replayed: true (or 409 if hashes diverge).
//   7. Key > 255 chars → 400 BadRequestException
//      'invalid_idempotency_key', no DB hit.
//   8. Empty / whitespace-only key string → treated as no key
//      (opt-out path).
//   9. Hash function is canonical: same inputs in different order →
//      same hash; differing inputs → different hash.
// =====================================================================

describe('GiftsService — F3-adjacent: Week 2 idempotency on create', () => {
  let service: GiftsService;
  let prisma: MockPrisma;
  let notifications: { trigger: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    notifications = { trigger: jest.fn().mockResolvedValue(undefined) };

    // Default happy-path mocks so a fresh create() reaches the
    // prisma.gift.create site without tripping earlier validations.
    prisma.user.findUnique.mockResolvedValue({
      qiftUsername: 'sender_handle',
    });
    prisma.user.findFirst.mockResolvedValue({ id: RECEIVER_ID });
    prisma.address.findFirst.mockResolvedValue({ id: 'addr_1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: BlocksService,
          useValue: {
            isBlockedEitherWay: jest.fn().mockResolvedValue(false),
          },
        },
      ],
    }).compile();
    service = module.get<GiftsService>(GiftsService);
  });

  function makeBody(
    overrides: Partial<{
      receiverUsername: string;
      productName: string;
      storeName: string;
      productId: string;
      storeId: string;
      messageText: string;
      isAnonymous: boolean;
      isSurprise: boolean;
    }> = {},
  ) {
    return {
      receiverUsername: 'receiver_handle',
      productName: 'باقة جوري',
      storeName: 'باقات الرياض',
      ...overrides,
    };
  }

  function makeCreatedGiftRow(extra: Record<string, unknown> = {}) {
    return {
      id: 'gift_1',
      senderId: SENDER_ID,
      receiverId: RECEIVER_ID,
      productName: 'باقة جوري',
      storeName: 'باقات الرياض',
      productId: null,
      storeId: null,
      status: 'pending_address',
      isAnonymous: false,
      isSurprise: false,
      idempotencyKey: null,
      idempotencyRequestHash: null,
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
      ...extra,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  describe('opt-out: no Idempotency-Key', () => {
    it('returns { replayed: false } and persists NULL key + hash', async () => {
      prisma.gift.create.mockResolvedValue(makeCreatedGiftRow());

      const result = await service.create(makeBody(), SENDER_ID);

      expect(result.replayed).toBe(false);
      expect(result.gift).toBeDefined();
      // Pre-check is skipped — no findFirst call for idempotency.
      expect(prisma.gift.findFirst).not.toHaveBeenCalled();
      // Persisted data has NULL for both columns (compound unique
      // permits multiple NULLs).
      const createArg = prisma.gift.create.mock.calls[0][0] as {
        data: {
          idempotencyKey: string | null;
          idempotencyRequestHash: string | null;
        };
      };
      expect(createArg.data.idempotencyKey).toBeNull();
      expect(createArg.data.idempotencyRequestHash).toBeNull();
    });

    it('empty-string key is treated as no key (opt-out)', async () => {
      prisma.gift.create.mockResolvedValue(makeCreatedGiftRow());

      await service.create(makeBody(), SENDER_ID, '   ');

      expect(prisma.gift.findFirst).not.toHaveBeenCalled();
      const createArg = prisma.gift.create.mock.calls[0][0] as {
        data: { idempotencyKey: string | null };
      };
      expect(createArg.data.idempotencyKey).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('first call with a key persists key + hash', () => {
    it('persists the trimmed key and a SHA-256 request hash; returns replayed=false', async () => {
      prisma.gift.create.mockResolvedValue(
        makeCreatedGiftRow({
          idempotencyKey: 'key-abc',
          idempotencyRequestHash: 'expected-hash-stub',
        }),
      );

      const result = await service.create(makeBody(), SENDER_ID, '  key-abc  ');

      expect(result.replayed).toBe(false);
      const createArg = prisma.gift.create.mock.calls[0][0] as {
        data: { idempotencyKey: string; idempotencyRequestHash: string };
      };
      expect(createArg.data.idempotencyKey).toBe('key-abc');
      // SHA-256 hex is 64 lowercase chars.
      expect(createArg.data.idempotencyRequestHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('pre-check runs against (senderId, key)', async () => {
      prisma.gift.create.mockResolvedValue(makeCreatedGiftRow());

      await service.create(makeBody(), SENDER_ID, 'key-1');

      expect(prisma.gift.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { senderId: SENDER_ID, idempotencyKey: 'key-1' },
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('replay: same (sender, key, payload) → original gift', () => {
    it('returns the existing gift with replayed=true; does NOT call prisma.gift.create', async () => {
      // We need the stored hash to MATCH what computeGiftRequestHash
      // will produce for the same body. Strategy: do one create call
      // first to capture the hash the service writes; then use that
      // exact hash on a second findFirst-returns-existing setup.
      prisma.gift.create.mockResolvedValueOnce(
        makeCreatedGiftRow({
          idempotencyKey: 'key-replay',
          idempotencyRequestHash: 'will-be-replaced',
        }),
      );
      await service.create(makeBody(), SENDER_ID, 'key-replay');
      const writtenHash = (
        prisma.gift.create.mock.calls[0][0] as {
          data: { idempotencyRequestHash: string };
        }
      ).data.idempotencyRequestHash;

      // Second call: pre-check finds an existing row with the same
      // hash. Service returns it with replayed=true.
      prisma.gift.findFirst.mockResolvedValueOnce(
        makeCreatedGiftRow({
          idempotencyKey: 'key-replay',
          idempotencyRequestHash: writtenHash,
        }),
      );
      const second = await service.create(makeBody(), SENDER_ID, 'key-replay');

      expect(second.replayed).toBe(true);
      // prisma.gift.create called only ONCE total (during the first
      // setup call above). The replay call must NOT hit create.
      expect(prisma.gift.create).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('hash mismatch: same key, DIFFERENT payload → 409', () => {
    it('throws ConflictException with code idempotency_key_reused', async () => {
      // findFirst returns a row with a hash that won't match the
      // new body's canonical hash. Persistent (not once-only) so
      // both .rejects assertions below re-trigger the same pre-
      // check path.
      prisma.gift.findFirst.mockResolvedValue(
        makeCreatedGiftRow({
          idempotencyKey: 'key-conflict',
          idempotencyRequestHash:
            '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      );

      await expect(
        service.create(
          makeBody({ productName: 'totally different product' }),
          SENDER_ID,
          'key-conflict',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.create(
          makeBody({ productName: 'totally different product' }),
          SENDER_ID,
          'key-conflict',
        ),
      ).rejects.toThrow('Idempotency-Key reused');

      // gift.create never called — pre-check short-circuited.
      expect(prisma.gift.create).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('namespace isolation: same key value, different senders', () => {
    it('does NOT collide; the pre-check filters by senderId', async () => {
      // Sender A creates with key-shared.
      prisma.gift.create.mockResolvedValueOnce(
        makeCreatedGiftRow({
          id: 'gift_a',
          senderId: 'user_A',
          idempotencyKey: 'key-shared',
        }),
      );
      // Sender B does NOT see sender A's gift in the pre-check.
      // findFirst returns null because where: {senderId: 'user_B',
      // idempotencyKey: 'key-shared'} does not match A's row.
      // (Default mock for findFirst already returns null.)
      prisma.gift.create.mockResolvedValueOnce(
        makeCreatedGiftRow({
          id: 'gift_b',
          senderId: 'user_B',
          idempotencyKey: 'key-shared',
        }),
      );

      await service.create(makeBody(), 'user_A', 'key-shared');
      await service.create(makeBody(), 'user_B', 'key-shared');

      // Both senders triggered a real create. No replay.
      expect(prisma.gift.create).toHaveBeenCalledTimes(2);
      // Each findFirst pre-check used the sender's own ID.
      const findCalls = prisma.gift.findFirst.mock.calls.map(
        (c) => (c[0] as { where: { senderId: string } }).where.senderId,
      );
      expect(findCalls).toEqual(['user_A', 'user_B']);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('concurrent retry race: prisma.gift.create rejects with P2002', () => {
    // Three cases:
    //   1. Hash matches winner    → replayed=true returned
    //   2. Hash mismatches winner → 409 idempotency_key_reused
    //   3. Non-P2002 Prisma error → propagated as-is

    it('hash match path: replayed=true returned', async () => {
      // Phase 1: capture canonical hash for makeBody() via a normal
      // create call.
      prisma.gift.create.mockResolvedValueOnce(
        makeCreatedGiftRow({ idempotencyKey: 'key-warmup' }),
      );
      await service.create(makeBody(), SENDER_ID, 'key-warmup');
      const canonicalHash = (
        prisma.gift.create.mock.calls[0][0] as {
          data: { idempotencyRequestHash: string };
        }
      ).data.idempotencyRequestHash;

      // Phase 2: race scenario. Pre-check sees nothing, create
      // rejects with P2002, refetch returns winner with matching
      // hash.
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: 'test' },
      );
      prisma.gift.findFirst.mockResolvedValueOnce(null);
      prisma.gift.create.mockRejectedValueOnce(p2002);
      prisma.gift.findFirst.mockResolvedValueOnce(
        makeCreatedGiftRow({
          id: 'gift_winner',
          idempotencyKey: 'key-race',
          idempotencyRequestHash: canonicalHash,
        }),
      );

      const result = await service.create(makeBody(), SENDER_ID, 'key-race');

      expect(result.replayed).toBe(true);
      expect((result.gift as { id: string }).id).toBe('gift_winner');
    });

    it('hash mismatch path on race winner: throws 409', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: 'test' },
      );
      prisma.gift.findFirst.mockResolvedValueOnce(null);
      prisma.gift.create.mockRejectedValueOnce(p2002);
      // The winner has a DIFFERENT canonical hash (e.g., it was
      // submitted with a different payload).
      prisma.gift.findFirst.mockResolvedValueOnce(
        makeCreatedGiftRow({
          idempotencyKey: 'key-race-conflict',
          idempotencyRequestHash:
            '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      );

      await expect(
        service.create(makeBody(), SENDER_ID, 'key-race-conflict'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-P2002 Prisma errors are propagated as-is', async () => {
      // A different Prisma error code must NOT be misinterpreted
      // as an idempotency race. P2025 (RecordNotFound) is a typical
      // example.
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        'Record not found',
        { code: 'P2025', clientVersion: 'test' },
      );
      prisma.gift.findFirst.mockResolvedValueOnce(null);
      prisma.gift.create.mockRejectedValueOnce(p2025);

      await expect(
        service.create(makeBody(), SENDER_ID, 'key-other-error'),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('key validation', () => {
    it('throws BadRequest(invalid_idempotency_key) for keys > 255 chars', async () => {
      const tooLong = 'x'.repeat(256);

      await expect(
        service.create(makeBody(), SENDER_ID, tooLong),
      ).rejects.toThrow('invalid_idempotency_key');

      expect(prisma.gift.findFirst).not.toHaveBeenCalled();
      expect(prisma.gift.create).not.toHaveBeenCalled();
    });

    it('255-char key is accepted (boundary)', async () => {
      const exactly255 = 'x'.repeat(255);
      prisma.gift.create.mockResolvedValue(
        makeCreatedGiftRow({ idempotencyKey: exactly255 }),
      );

      await expect(
        service.create(makeBody(), SENDER_ID, exactly255),
      ).resolves.toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('hash function is canonical (same payload → same hash)', () => {
    it('hash is stable across input-property ordering', async () => {
      // Two distinct objects with the same canonical content should
      // produce the same hash regardless of key declaration order.
      prisma.gift.create.mockResolvedValueOnce(makeCreatedGiftRow());
      prisma.gift.create.mockResolvedValueOnce(makeCreatedGiftRow());

      const body1 = {
        receiverUsername: 'r',
        productName: 'p',
        storeName: 's',
        isAnonymous: true,
        isSurprise: false,
      };
      const body2 = {
        // Same content, different key order, equivalent values.
        isSurprise: false,
        storeName: 's',
        isAnonymous: true,
        productName: 'p',
        receiverUsername: 'r',
      };

      await service.create(body1, 'sender_h1', 'k1');
      await service.create(body2, 'sender_h2', 'k2');

      const hash1 = (
        prisma.gift.create.mock.calls[0][0] as {
          data: { idempotencyRequestHash: string };
        }
      ).data.idempotencyRequestHash;
      const hash2 = (
        prisma.gift.create.mock.calls[1][0] as {
          data: { idempotencyRequestHash: string };
        }
      ).data.idempotencyRequestHash;
      expect(hash1).toBe(hash2);
    });

    it('hash differs when payload differs', async () => {
      prisma.gift.create.mockResolvedValueOnce(makeCreatedGiftRow());
      prisma.gift.create.mockResolvedValueOnce(makeCreatedGiftRow());

      await service.create(makeBody({ productName: 'A' }), SENDER_ID, 'k-a');
      await service.create(makeBody({ productName: 'B' }), SENDER_ID, 'k-b');

      const hashA = (
        prisma.gift.create.mock.calls[0][0] as {
          data: { idempotencyRequestHash: string };
        }
      ).data.idempotencyRequestHash;
      const hashB = (
        prisma.gift.create.mock.calls[1][0] as {
          data: { idempotencyRequestHash: string };
        }
      ).data.idempotencyRequestHash;
      expect(hashA).not.toBe(hashB);
    });
  });
});
