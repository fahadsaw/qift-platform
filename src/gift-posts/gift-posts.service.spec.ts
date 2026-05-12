// GiftPost V1 social-layer tests.
//
// Verifies the rules captured in:
//   - project_privacy_first_posts.md  (identity masked by default)
//   - project_gift_post_sharing.md    (slug URLs are privacy-safe)
//   - project_scalability_principles  (idempotent + race-safe writes)
//
// We mock PrismaService directly so the tests stay deterministic and
// fast. The behavior under test is privacy projection + visibility
// gating + transactional counter writes — all of which are exact
// Prisma call shapes.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GiftPostsService } from './gift-posts.service';
import { PrismaService } from '../prisma/prisma.service';

type MockPrisma = {
  gift: { findUnique: jest.Mock };
  giftPost: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  giftPostAppreciation: {
    findUnique: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
  $transaction: jest.Mock;
};

function createPrismaMock(): MockPrisma {
  const giftPostAppreciation = {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  };
  const giftPost = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  // The service uses prisma.$transaction with an async callback that
  // receives a `tx` argument; the mock just runs the callback against
  // the same surface. That's enough for unit tests — the real
  // transactional guarantees are a database property, not a service
  // one, and integration tests against a live DB are future work.
  const $transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ giftPostAppreciation, giftPost }),
  );
  return {
    gift: { findUnique: jest.fn() },
    giftPost,
    giftPostAppreciation,
    $transaction,
  };
}

describe('GiftPostsService', () => {
  let service: GiftPostsService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftPostsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<GiftPostsService>(GiftPostsService);
  });

  // ── publish ─────────────────────────────────────────────────

  describe('publish', () => {
    const senderId = 'user_sender';
    const receiverId = 'user_receiver';
    const giftId = 'gift_1';
    const productId = 'prod_1';
    const baseGift = {
      id: giftId,
      senderId,
      receiverId,
      productId,
      status: 'delivered' as const,
    };

    it('creates a privacy-safe GiftPost row on first publish', async () => {
      prisma.gift.findUnique.mockResolvedValue(baseGift);
      prisma.giftPost.findUnique.mockResolvedValue(null);
      // Slug uniqueness probe returns null (no collision).
      prisma.giftPost.findUnique.mockResolvedValueOnce(null);
      prisma.giftPost.create.mockResolvedValue({
        id: 'post_1',
        giftId,
        ownerUserId: senderId,
        direction: 'sent',
        publishedAt: new Date(),
        visibility: 'public',
        publicSlug: 'abc123',
        revealSender: false,
        revealRecipient: false,
        appreciationCount: 0,
        deactivatedAt: null,
        deactivatedReason: null,
      });

      const created = await service.publish(senderId, { giftId });
      expect(created).toBeDefined();
      expect(prisma.giftPost.create).toHaveBeenCalledTimes(1);
      const payload = prisma.giftPost.create.mock.calls[0][0].data;
      // Privacy invariant: no buyer-identity-leak fields exist on
      // the data payload. ownerUserId + direction + publishedAt +
      // publicSlug + visibility are the ONLY new identity-adjacent
      // fields. revealSender / revealRecipient stay default false.
      expect(payload.ownerUserId).toBe(senderId);
      expect(payload.direction).toBe('sent');
      expect(payload.visibility).toBe('public');
      expect(payload.publishedAt).toBeInstanceOf(Date);
      expect(typeof payload.publicSlug).toBe('string');
      expect(payload.publicSlug.length).toBeGreaterThan(8);
      // The payload should NOT carry receiverId, senderName, gift
      // message text, address, or any other identity-bearing field
      // that would leak through the new row.
      expect(payload).not.toHaveProperty('receiverId');
      expect(payload).not.toHaveProperty('senderName');
      expect(payload).not.toHaveProperty('messageText');
      expect(payload).not.toHaveProperty('addressId');
      // V1 defaults: identity reveal stays off forever for V1 users.
      expect(payload.revealSender).toBeUndefined();
      expect(payload.revealRecipient).toBeUndefined();
    });

    it('rejects publish on a cancelled gift', async () => {
      prisma.gift.findUnique.mockResolvedValue({
        ...baseGift,
        status: 'cancelled',
      });
      prisma.giftPost.findUnique.mockResolvedValue(null);
      await expect(
        service.publish(senderId, { giftId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.giftPost.create).not.toHaveBeenCalled();
    });

    it('rejects publish from a third party (not sender, not receiver)', async () => {
      prisma.gift.findUnique.mockResolvedValue(baseGift);
      await expect(
        service.publish('user_other', { giftId }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws 409 when the other gift party already published', async () => {
      prisma.gift.findUnique.mockResolvedValue(baseGift);
      // Existing post is owned by the receiver — sender tries to
      // publish; we surface a conflict instead of silently
      // overwriting their visibility.
      prisma.giftPost.findUnique.mockResolvedValue({
        id: 'post_existing',
        giftId,
        ownerUserId: receiverId,
        direction: 'received',
        publishedAt: new Date(),
        publicSlug: 'xyz789',
        visibility: 'public',
        appreciationCount: 0,
        deactivatedAt: null,
      });
      await expect(
        service.publish(senderId, { giftId }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('is idempotent — returns existing row on re-publish by same owner', async () => {
      const existing = {
        id: 'post_1',
        giftId,
        ownerUserId: senderId,
        direction: 'sent',
        publishedAt: new Date(),
        visibility: 'public',
        publicSlug: 'abc123',
        revealSender: false,
        revealRecipient: false,
        appreciationCount: 3,
        deactivatedAt: null,
        deactivatedReason: null,
      };
      prisma.gift.findUnique.mockResolvedValue(baseGift);
      prisma.giftPost.findUnique.mockResolvedValue(existing);
      const result = await service.publish(senderId, { giftId });
      expect(result).toEqual(existing);
      expect(prisma.giftPost.create).not.toHaveBeenCalled();
      expect(prisma.giftPost.update).not.toHaveBeenCalled();
    });

    it('reuses the existing publicSlug on republish after unpublish', async () => {
      // Existing row was published then unpublished — publishedAt
      // is null but publicSlug is preserved. Republish should
      // reuse the slug so a shared link never 404s.
      const existing = {
        id: 'post_1',
        giftId,
        ownerUserId: senderId,
        direction: 'sent',
        publishedAt: null,
        visibility: 'private',
        publicSlug: 'preserved_slug',
        revealSender: false,
        revealRecipient: false,
        appreciationCount: 2,
        deactivatedAt: null,
        deactivatedReason: null,
      };
      prisma.gift.findUnique.mockResolvedValue(baseGift);
      prisma.giftPost.findUnique.mockResolvedValue(existing);
      prisma.giftPost.update.mockResolvedValue({
        ...existing,
        publishedAt: new Date(),
        visibility: 'public',
      });
      await service.publish(senderId, { giftId });
      const updatePayload = prisma.giftPost.update.mock.calls[0][0].data;
      expect(updatePayload.publicSlug).toBe('preserved_slug');
      expect(updatePayload.publishedAt).toBeInstanceOf(Date);
      // Republish also clears any deactivation — owner re-surfacing
      // the post overrides the soft-hide.
      expect(updatePayload.deactivatedAt).toBeNull();
      expect(updatePayload.deactivatedReason).toBeNull();
    });
  });

  // ── getBySlug ───────────────────────────────────────────────

  describe('getBySlug', () => {
    const senderId = 'user_sender';
    const receiverId = 'user_receiver';
    const baseRow = {
      id: 'post_1',
      ownerUserId: senderId,
      direction: 'sent',
      publishedAt: new Date(),
      visibility: 'public',
      publicSlug: 'abc',
      revealSender: false,
      revealRecipient: false,
      appreciationCount: 0,
      deactivatedAt: null,
      gift: {
        id: 'gift_1',
        senderId,
        receiverId,
        productId: 'prod_1',
        storeId: 'store_1',
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        product: { imageUrl: 'https://r2.qift.app/p1.jpg' },
        sender: { qiftUsername: 'sender', fullName: 'The Sender' },
        receiver: { qiftUsername: 'receiver', fullName: 'The Receiver' },
      },
    };

    it('returns a privacy-masked view for an anonymous viewer on a public post', async () => {
      prisma.giftPost.findUnique.mockResolvedValue(baseRow);
      const view = await service.getBySlug('abc', null);
      // The view payload includes product info and the masked
      // identity fields — both sender + receiver identity stay
      // null for a third-party viewer.
      expect(view.productName).toBe('باقة جوري');
      expect(view.storeName).toBe('باقات الرياض');
      expect(view.productImageUrl).toBe('https://r2.qift.app/p1.jpg');
      expect(view.senderUsername).toBeNull();
      expect(view.senderName).toBeNull();
      expect(view.receiverUsername).toBeNull();
      expect(view.receiverName).toBeNull();
      // Deep-link includes the product id (storefront product-modal
      // convention).
      expect(view.productHref).toBe('/stores/store_1?product=prod_1');
    });

    it('404s on a private post for a third-party viewer (no existence leak)', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...baseRow,
        visibility: 'private',
      });
      await expect(
        service.getBySlug('abc', 'user_other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s on an unpublished post for a third-party viewer', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...baseRow,
        publishedAt: null,
      });
      await expect(service.getBySlug('abc', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s on a deactivated post for anonymous viewers', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...baseRow,
        deactivatedAt: new Date(),
      });
      await expect(service.getBySlug('abc', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('allows the owner to view their own unpublished post', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...baseRow,
        publishedAt: null,
        visibility: 'private',
      });
      // Owner gets the masked view back (their own viewerUserId
      // matches the sender → buildGiftPostView reveals identity to
      // them).
      const view = await service.getBySlug('abc', senderId);
      expect(view.productName).toBe('باقة جوري');
      // Owner sees both sides (they were a party to the gift).
      expect(view.senderUsername).toBe('sender');
      expect(view.receiverUsername).toBe('receiver');
    });

    it('allows the gift counterparty (receiver) to view a sender-owned post even when unpublished', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...baseRow,
        publishedAt: null,
        visibility: 'private',
      });
      const view = await service.getBySlug('abc', receiverId);
      expect(view.productName).toBe('باقة جوري');
    });
  });

  // ── listByUser ──────────────────────────────────────────────

  describe('listByUser', () => {
    it('filters to published + public + not deactivated only', async () => {
      prisma.giftPost.findMany.mockResolvedValue([]);
      await service.listByUser('target_user', null);
      const where = prisma.giftPost.findMany.mock.calls[0][0].where;
      expect(where.ownerUserId).toBe('target_user');
      expect(where.publishedAt).toEqual({ not: null });
      expect(where.visibility).toBe('public');
      expect(where.deactivatedAt).toBeNull();
    });
  });

  // ── appreciate ──────────────────────────────────────────────

  describe('appreciate', () => {
    const ownerId = 'user_owner';
    const viewerId = 'user_viewer';
    const postId = 'post_1';
    const publicPost = {
      id: postId,
      ownerUserId: ownerId,
      publishedAt: new Date(),
      visibility: 'public',
      deactivatedAt: null,
      appreciationCount: 0,
    };

    it('blocks self-appreciation', async () => {
      prisma.giftPost.findUnique.mockResolvedValue(publicPost);
      await expect(service.appreciate(ownerId, postId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('blocks appreciation on a private post', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...publicPost,
        visibility: 'private',
      });
      await expect(service.appreciate(viewerId, postId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('blocks appreciation on a deactivated post', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...publicPost,
        deactivatedAt: new Date(),
      });
      await expect(service.appreciate(viewerId, postId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('creates the appreciation row + increments the counter on first toggle', async () => {
      prisma.giftPost.findUnique.mockResolvedValue(publicPost);
      // Optimistic create succeeds.
      prisma.giftPostAppreciation.create.mockResolvedValue({
        id: 'app_1',
        giftPostId: postId,
        userId: viewerId,
      });
      prisma.giftPost.update.mockResolvedValue({ appreciationCount: 1 });

      const result = await service.appreciate(viewerId, postId);
      expect(result).toEqual({ appreciated: true, appreciationCount: 1 });
      expect(prisma.giftPostAppreciation.create).toHaveBeenCalledTimes(1);
      expect(prisma.giftPost.update).toHaveBeenCalledTimes(1);
      // Counter write uses `increment: 1` — atomic, race-safe.
      const data = prisma.giftPost.update.mock.calls[0][0].data;
      expect(data.appreciationCount).toEqual({ increment: 1 });
    });

    it('falls through to delete+decrement on a unique-constraint violation (already appreciated)', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...publicPost,
        appreciationCount: 1,
      });
      // First $transaction attempt (create+increment) hits the
      // unique constraint — Prisma surfaces `code: 'P2002'`.
      const uniqueErr: Error & { code?: string } = new Error('duplicate');
      uniqueErr.code = 'P2002';
      prisma.giftPostAppreciation.create.mockRejectedValueOnce(uniqueErr);
      // Second $transaction attempt (delete+decrement) succeeds.
      prisma.giftPostAppreciation.delete.mockResolvedValue({ id: 'app_1' });
      prisma.giftPost.update.mockResolvedValue({ appreciationCount: 0 });

      const result = await service.appreciate(viewerId, postId);
      expect(result).toEqual({ appreciated: false, appreciationCount: 0 });
      expect(prisma.giftPostAppreciation.delete).toHaveBeenCalledTimes(1);
    });

    it('clamps negative counters defensively on the response', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        ...publicPost,
        appreciationCount: 0,
      });
      const uniqueErr: Error & { code?: string } = new Error('duplicate');
      uniqueErr.code = 'P2002';
      prisma.giftPostAppreciation.create.mockRejectedValueOnce(uniqueErr);
      prisma.giftPostAppreciation.delete.mockResolvedValue({ id: 'app_1' });
      // Defensive: pretend the counter drifted negative.
      prisma.giftPost.update.mockResolvedValue({ appreciationCount: -1 });

      const result = await service.appreciate(viewerId, postId);
      expect(result.appreciationCount).toBe(0);
    });
  });

  // ── unpublish ───────────────────────────────────────────────

  describe('unpublish', () => {
    const ownerId = 'user_owner';

    it('clears publishedAt but preserves publicSlug', async () => {
      const post = {
        id: 'post_1',
        ownerUserId: ownerId,
        publishedAt: new Date(),
        visibility: 'public',
        publicSlug: 'preserved',
        appreciationCount: 4,
      };
      prisma.giftPost.findUnique.mockResolvedValue(post);
      prisma.giftPost.update.mockResolvedValue({
        ...post,
        publishedAt: null,
      });

      await service.unpublish(ownerId, 'post_1');
      const data = prisma.giftPost.update.mock.calls[0][0].data;
      expect(data.publishedAt).toBeNull();
      // publicSlug is intentionally NOT touched — see schema
      // comment + publish-after-unpublish test.
      expect(data).not.toHaveProperty('publicSlug');
      // appreciationCount is preserved (soft hide, not delete).
      expect(data).not.toHaveProperty('appreciationCount');
    });

    it('rejects unpublish from a non-owner', async () => {
      prisma.giftPost.findUnique.mockResolvedValue({
        id: 'post_1',
        ownerUserId: ownerId,
        publishedAt: new Date(),
      });
      await expect(
        service.unpublish('other_user', 'post_1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is idempotent — returns the post unchanged when already unpublished', async () => {
      const post = {
        id: 'post_1',
        ownerUserId: ownerId,
        publishedAt: null,
        visibility: 'private',
      };
      prisma.giftPost.findUnique.mockResolvedValue(post);
      const result = await service.unpublish(ownerId, 'post_1');
      expect(result).toEqual(post);
      expect(prisma.giftPost.update).not.toHaveBeenCalled();
    });
  });
});
