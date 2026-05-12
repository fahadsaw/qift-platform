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
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GiftPostsService } from './gift-posts.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

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
  block: { findFirst: jest.Mock };
  // Throttle probe for the appreciation-notification path.
  notification: { findFirst: jest.Mock };
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
    // Block probe — defaults to "no block exists" so the happy-path
    // tests don't need to set it explicitly. Block-aware tests
    // override per-test.
    block: { findFirst: jest.fn().mockResolvedValue(null) },
    // Appreciation-notification throttle probe — defaults to "no
    // recent ping" so the notify path fires by default. Throttle-
    // aware tests override.
    notification: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction,
  };
}

// NotificationsService mock — captures trigger() calls so the
// appreciation tests can assert on the title / link / type.
type MockNotifications = { trigger: jest.Mock };
function createNotificationsMock(): MockNotifications {
  return { trigger: jest.fn().mockResolvedValue(undefined) };
}

describe('GiftPostsService', () => {
  let service: GiftPostsService;
  let prisma: MockPrisma;
  let notifications: MockNotifications;

  beforeEach(async () => {
    prisma = createPrismaMock();
    notifications = createNotificationsMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiftPostsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
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

    it('allows both sender and receiver to independently publish their own post', async () => {
      // The composite (giftId, ownerUserId) lookup returns null when
      // the OTHER side has published but the viewer hasn't — so the
      // viewer's publish path proceeds as a fresh first-time publish.
      // Both sides end up with their own GiftPost row keyed on
      // (giftId, ownerUserId). Phase 4 retired the 409 ConflictException.
      prisma.gift.findUnique.mockResolvedValue(baseGift);
      // First call: composite lookup for this viewer's existing post → null
      // Second call: slug uniqueness probe → null (no collision)
      prisma.giftPost.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      prisma.giftPost.create.mockResolvedValue({
        id: 'post_received',
        giftId,
        ownerUserId: receiverId,
        direction: 'received',
        publishedAt: new Date(),
        visibility: 'public',
        publicSlug: 'rcv1',
        revealSender: false,
        revealRecipient: false,
        appreciationCount: 0,
        deactivatedAt: null,
      });
      await service.publish(receiverId, { giftId });
      expect(prisma.giftPost.create).toHaveBeenCalledTimes(1);
      const payload = prisma.giftPost.create.mock.calls[0][0].data;
      // Direction comes from which side is publishing — receiver here.
      expect(payload.direction).toBe('received');
      expect(payload.ownerUserId).toBe(receiverId);
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

    it('404s when a third-party viewer is blocked by the owner (or vice versa)', async () => {
      // Public post on the wire — would normally be viewable.
      prisma.giftPost.findUnique.mockResolvedValue(baseRow);
      // Block exists either direction → collapse to 404 (no existence leak).
      prisma.block.findFirst.mockResolvedValueOnce({ blockerId: senderId });
      await expect(
        service.getBySlug('abc', 'random_viewer'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets the owner view their own post without consulting the block probe', async () => {
      // Defensive: a block row that mentions the owner must NOT
      // affect the owner's own view. The block probe should not
      // even be called for the owner-viewer case.
      prisma.giftPost.findUnique.mockResolvedValue(baseRow);
      const view = await service.getBySlug('abc', senderId);
      expect(view).toBeDefined();
      expect(prisma.block.findFirst).not.toHaveBeenCalled();
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

    it('returns empty when the viewer has blocked the wall owner', async () => {
      // Viewer initiated the block. Either direction hides the wall.
      prisma.block.findFirst.mockResolvedValueOnce({ blockerId: 'viewer_a' });
      const out = await service.listByUser('owner_b', 'viewer_a');
      expect(out).toEqual([]);
      // listByUser should short-circuit BEFORE hitting the posts table.
      expect(prisma.giftPost.findMany).not.toHaveBeenCalled();
    });

    it('returns empty when the wall owner has blocked the viewer', async () => {
      // Reverse direction — owner blocked the viewer.
      prisma.block.findFirst.mockResolvedValueOnce({ blockerId: 'owner_b' });
      const out = await service.listByUser('owner_b', 'viewer_a');
      expect(out).toEqual([]);
      expect(prisma.giftPost.findMany).not.toHaveBeenCalled();
    });

    it('skips the block probe for anonymous viewers', async () => {
      // Anonymous viewer (no JWT) — no block possible, no probe.
      prisma.giftPost.findMany.mockResolvedValue([]);
      await service.listByUser('owner_b', null);
      expect(prisma.block.findFirst).not.toHaveBeenCalled();
      expect(prisma.giftPost.findMany).toHaveBeenCalledTimes(1);
    });

    it('skips the block probe when viewer is the owner', async () => {
      // Owner viewing their own wall via the public endpoint — no
      // block check needed; you can't block yourself.
      prisma.giftPost.findMany.mockResolvedValue([]);
      await service.listByUser('user_a', 'user_a');
      expect(prisma.block.findFirst).not.toHaveBeenCalled();
      expect(prisma.giftPost.findMany).toHaveBeenCalledTimes(1);
    });

    it('collapses repeat gifts of the same product into ONE entry with eventCount = N', async () => {
      // Three rows, same owner + direction + productId — they should
      // collapse into one representative with eventCount=3. The
      // most-recent row (rows are pre-sorted DESC) is the rep.
      const baseGift = {
        id: 'g_x',
        senderId: 'sender_a',
        receiverId: 'owner_x',
        productId: 'prod_flowers',
        storeId: 'store_x',
        productName: 'باقة',
        storeName: 'متجر',
        product: { imageUrl: 'https://r2/p.jpg', images: [] },
        sender: { qiftUsername: 'sender', fullName: null },
        receiver: { qiftUsername: 'owner', fullName: null },
      };
      const row = (id: string, publishedAt: Date): Record<string, unknown> => ({
        id,
        ownerUserId: 'owner_x',
        direction: 'received',
        publishedAt,
        visibility: 'public',
        revealSender: false,
        revealRecipient: false,
        deactivatedAt: null,
        appreciationCount: 0,
        publicSlug: id,
        gift: { ...baseGift, id: `${id}_gift`, productId: 'prod_flowers' },
      });
      prisma.giftPost.findMany.mockResolvedValue([
        row('post_3', new Date('2026-05-13T10:00:00Z')), // newest
        row('post_2', new Date('2026-05-12T10:00:00Z')),
        row('post_1', new Date('2026-05-11T10:00:00Z')),
      ]);
      const out = await service.listByUser('owner_x', null);
      expect(out).toHaveLength(1);
      expect((out[0] as { eventCount: number }).eventCount).toBe(3);
      // Representative is the newest row.
      expect((out[0] as { postId: string }).postId).toBe('post_3');
    });

    it('does NOT collapse posts that lack a productId (legacy free-text gifts)', async () => {
      const legacyRow = (id: string): Record<string, unknown> => ({
        id,
        ownerUserId: 'owner_x',
        direction: 'sent',
        publishedAt: new Date(),
        visibility: 'public',
        revealSender: false,
        revealRecipient: false,
        deactivatedAt: null,
        appreciationCount: 0,
        publicSlug: id,
        gift: {
          id: `${id}_gift`,
          senderId: 'owner_x',
          receiverId: 'rcv',
          productId: null,
          storeId: null,
          productName: 'free-text',
          storeName: null,
          product: null,
          sender: { qiftUsername: 'owner', fullName: null },
          receiver: { qiftUsername: 'rcv', fullName: null },
        },
      });
      prisma.giftPost.findMany.mockResolvedValue([
        legacyRow('post_a'),
        legacyRow('post_b'),
      ]);
      const out = await service.listByUser('owner_x', null);
      // Two legacy gifts stay as two entries — no productId means
      // dedup can't safely group them; each stands alone.
      expect(out).toHaveLength(2);
      expect((out[0] as { eventCount: number }).eventCount).toBe(1);
      expect((out[1] as { eventCount: number }).eventCount).toBe(1);
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

    it('fires an aggregate appreciation notification to the post owner on first toggle', async () => {
      // Happy path: viewer appreciates a public post owned by
      // someone else; throttle probe finds no recent notification;
      // a fresh ping fires.
      prisma.giftPost.findUnique.mockResolvedValue(publicPost);
      prisma.giftPostAppreciation.create.mockResolvedValue({
        id: 'app_1',
        giftPostId: postId,
        userId: viewerId,
      });
      prisma.giftPost.update.mockResolvedValue({ appreciationCount: 1 });
      prisma.notification.findFirst.mockResolvedValueOnce(null);

      await service.appreciate(viewerId, postId);

      // Allow the void-fired notification microtask to settle.
      await new Promise((r) => setImmediate(r));

      expect(notifications.trigger).toHaveBeenCalledTimes(1);
      const call = notifications.trigger.mock.calls[0][0];
      // Privacy invariants — body never names the appreciator;
      // type is the new aggregate-friendly key; userId routes to
      // the OWNER, never the appreciator.
      expect(call.userId).toBe(ownerId);
      expect(call.type).toBe('gift_post.appreciated');
      expect(call.body).toBeNull();
      // Link encodes the post id so the throttle probe can match
      // on link string without a separate column.
      expect(call.link).toBe(`/profile?post=${encodeURIComponent(postId)}`);
    });

    it('does NOT fire a second notification within the 24h throttle window', async () => {
      // Throttle probe finds a recent ping — we stay silent.
      prisma.giftPost.findUnique.mockResolvedValue(publicPost);
      prisma.giftPostAppreciation.create.mockResolvedValue({
        id: 'app_1',
        giftPostId: postId,
        userId: viewerId,
      });
      prisma.giftPost.update.mockResolvedValue({ appreciationCount: 2 });
      prisma.notification.findFirst.mockResolvedValueOnce({ id: 'n_recent' });

      await service.appreciate(viewerId, postId);
      await new Promise((r) => setImmediate(r));

      expect(notifications.trigger).not.toHaveBeenCalled();
    });

    it('does NOT fire a notification on the un-appreciate path', async () => {
      // Toggle-off (delete+decrement) MUST NOT generate a ping —
      // we only notify on real new appreciations.
      prisma.giftPost.findUnique.mockResolvedValue({
        ...publicPost,
        appreciationCount: 1,
      });
      const uniqueErr: Error & { code?: string } = new Error('duplicate');
      uniqueErr.code = 'P2002';
      prisma.giftPostAppreciation.create.mockRejectedValueOnce(uniqueErr);
      prisma.giftPostAppreciation.delete.mockResolvedValue({ id: 'app_1' });
      prisma.giftPost.update.mockResolvedValue({ appreciationCount: 0 });

      await service.appreciate(viewerId, postId);
      await new Promise((r) => setImmediate(r));

      expect(notifications.trigger).not.toHaveBeenCalled();
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
