import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildGiftPostView,
  type GiftPostView,
} from '../gifts/gift-post-visibility';
import {
  NotificationsService,
  NotificationType,
} from '../notifications/notifications.service';

// Re-export so consumers can import the view type from this service
// without reaching into gifts/ directly.
export type { GiftPostView };

// ── V1 social layer for Qift gift posts ──────────────────────
//
// What this ships:
//   - publish(giftId)          — sender (V1) opts into sharing a gift.
//                                Creates the GiftPost row if missing,
//                                stamps publishedAt + generates publicSlug.
//                                Idempotent: re-publishing the same gift
//                                returns the existing row.
//   - unpublish(postId)        — owner pulls the post back to private.
//                                Clears publishedAt but KEEPS publicSlug so
//                                a future re-publish reuses the same /p/<slug>
//                                URL (no link-rot for shares).
//   - setVisibility(postId, v) — toggle 'private' | 'public'. V1 ships
//                                these two only; 'followers' is rejected.
//   - listMine(userId)         — owner's full wall (all states).
//   - listByUser(userId, vId)  — Gift Wall for /u/<username>; published +
//                                public + not deactivated only.
//   - getBySlug(slug, vId)     — /p/<slug> route. Privacy-masked via
//                                buildGiftPostView so identity defaults
//                                to anonymous even on a public post.
//   - appreciate(postId, uId)  — toggle 👍. Upserts the appreciation row
//                                and bumps the denormalized counter in a
//                                single transaction. Idempotent in both
//                                directions (calling on an existing
//                                appreciation un-toggles it).
//
// What this DOES NOT do (out of V1 scope, do not add here):
//   - comments / replies
//   - reels / video posts
//   - feed ranking
//   - followers-only visibility tier
//   - identity-reveal UI (revealSender/revealRecipient stay false)
//   - generic posting (no UploadController; posts are gift-anchored only)
//
// Privacy:
//   The viewer-facing payload routes through buildGiftPostView in
//   gifts/gift-post-visibility.ts. That helper is the single source of
//   truth for identity masking — extending it (not duplicating it here)
//   keeps the privacy rule from drifting across surfaces.

// Length of the URL slug. 12 bytes of randomness encoded base64url ≈ 16 chars;
// non-enumerable for all practical purposes. We retry on collision (the unique
// constraint enforces it at the DB level).
const SLUG_BYTES = 12;
const MAX_SLUG_RETRIES = 5;

export type PublishInput = {
  giftId: string;
  // V1 only accepts 'private' | 'public'. Default is 'public' on a
  // first-time publish — the user clicked Publish to share it.
  visibility?: 'private' | 'public';
};

export type AppreciationToggleResult = {
  appreciated: boolean;
  appreciationCount: number;
};

const FORBIDDEN_MSG = 'غير مصرح لك';

// Throttle window for appreciation notifications — at most one push
// per (post, owner) per this many ms. 24h chosen so a slow trickle
// of appreciations over a day still pings once, but a burst doesn't
// generate a burst of notifications. Aligns with the
// `project_notification_channels_policy` "calm by default" rule.
const APPRECIATION_NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class GiftPostsService {
  private readonly logger = new Logger(GiftPostsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // Opt-in publish. V1 publishes from the sender side — the gift-detail
  // page's "Share this gift" CTA only renders for the sender today.
  // Receiver-side publishing is a follow-up surface; the schema supports
  // it (ownerUserId + direction), so we keep the service flexible.
  async publish(viewerUserId: string, input: PublishInput) {
    const giftId = input.giftId?.trim();
    if (!giftId) {
      throw new BadRequestException('giftId is required');
    }
    const visibility = input.visibility ?? 'public';
    if (visibility !== 'private' && visibility !== 'public') {
      throw new BadRequestException('visibility must be private or public');
    }

    const gift = await this.prisma.gift.findUnique({
      where: { id: giftId },
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        productId: true,
        status: true,
      },
    });
    if (!gift) throw new NotFoundException('Gift not found');

    // Only the sender or receiver can publish their own gift moment.
    // V1 surfaces only the sender CTA, but we enforce both server-side
    // so a future receiver-side flow doesn't need a separate guard.
    const direction: 'sent' | 'received' =
      viewerUserId === gift.senderId
        ? 'sent'
        : viewerUserId === gift.receiverId
          ? 'received'
          : (() => {
              throw new ForbiddenException(FORBIDDEN_MSG);
            })();

    // Gift-status gate. A cancelled gift never represents a real
    // gifting moment we want to amplify — block publish here so an
    // admin-cancelled or sender-cancelled gift can't be retroactively
    // posted. Note: a *publish* of an already-published gift that
    // then gets cancelled is handled separately — GiftsService.cancel
    // deactivates the GiftPost row downstream.
    if (gift.status === 'cancelled') {
      throw new BadRequestException('لا يمكن مشاركة هدية ملغاة');
    }

    // GiftPost is keyed on (giftId, ownerUserId) — one post per
    // (gift, owner). Both sender and receiver can independently
    // publish their own perspective on the same Gift; the
    // server-side identity-masking helper (buildGiftPostView)
    // keeps the public payload privacy-safe regardless of which
    // side opted to share. The previous 409 ConflictException for
    // "the other side already published" was retired in Phase 4 —
    // both sides are now first-class.
    const existing = await this.prisma.giftPost.findUnique({
      where: {
        giftId_ownerUserId: { giftId, ownerUserId: viewerUserId },
      },
    });

    // Idempotent re-publish: the same owner clicks Publish again
    // (network blip, optimistic-UI retry). Return the existing row
    // unchanged so the frontend's local state stays consistent.
    // Visibility updates go through setVisibility() — we do NOT
    // silently rewrite visibility on a republish call.
    if (existing && existing.publishedAt !== null) {
      return existing;
    }

    // First-time publish: stamp publishedAt + generate publicSlug
    // (or reuse an existing slug from a prior publish/unpublish cycle
    // so live share links never 404).
    if (existing) {
      const slug = existing.publicSlug ?? (await this.generateUniqueSlug());
      const updated = await this.prisma.giftPost.update({
        where: { id: existing.id },
        data: {
          publishedAt: new Date(),
          publicSlug: slug,
          visibility,
          // Re-publish should clear deactivation, since the user has
          // explicitly chosen to surface the post again.
          deactivatedAt: null,
          deactivatedReason: null,
        },
      });
      return updated;
    }

    const slug = await this.generateUniqueSlug();
    const created = await this.prisma.giftPost.create({
      data: {
        giftId,
        ownerUserId: viewerUserId,
        direction,
        publishedAt: new Date(),
        publicSlug: slug,
        visibility,
      },
    });
    return created;
  }

  async unpublish(viewerUserId: string, postId: string) {
    const post = await this.requireOwnedPost(viewerUserId, postId);
    if (post.publishedAt === null) return post; // already unpublished
    const updated = await this.prisma.giftPost.update({
      where: { id: post.id },
      data: {
        publishedAt: null,
        // KEEP publicSlug — see comment on the schema; we reuse it
        // on re-publish so a shared link doesn't 404 between cycles.
      },
    });
    return updated;
  }

  async setVisibility(
    viewerUserId: string,
    postId: string,
    visibility: 'private' | 'public',
  ) {
    if (visibility !== 'private' && visibility !== 'public') {
      throw new BadRequestException('visibility must be private or public');
    }
    const post = await this.requireOwnedPost(viewerUserId, postId);
    if (post.visibility === visibility) return post;
    return this.prisma.giftPost.update({
      where: { id: post.id },
      data: { visibility },
    });
  }

  // Owner's wall — all states (published / unpublished / deactivated).
  // The frontend renders state pills so the owner sees which posts are
  // live vs draft.
  async listMine(viewerUserId: string) {
    const rows = await this.prisma.giftPost.findMany({
      where: { ownerUserId: viewerUserId },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      include: this.giftInclude(),
    });
    // Dedup by (ownerUserId, direction, productId). Repeat gifts of
    // the same product to the same owner collapse into ONE entry
    // with a denormalized `eventCount`. The "representative" post
    // is the most recent (rows are pre-sorted DESC). See sub-task 3
    // of Phase 4 and `project_gift_post_dedup.md`.
    const grouped = collapseGiftPostGroups(rows);
    return grouped.map(({ row, eventCount }) =>
      this.toView(row, viewerUserId, /* forceVisible */ true, eventCount),
    );
  }

  // Public Gift Wall for /u/<username>. Filters down to published +
  // public + not-deactivated posts. Owner viewing their own wall via
  // this endpoint sees the same filter — they have listMine() for
  // their full wall.
  //
  // Privacy: when the viewer has blocked the wall owner (or vice
  // versa), we return an empty list. Blocks are bidirectional —
  // either direction hides the wall, matching the existing block
  // semantics elsewhere in the codebase (search + send-gift +
  // public profile). A blocked relationship should erase the other
  // side from the viewer's experience entirely.
  async listByUser(targetUserId: string, viewerUserId: string | null) {
    if (
      viewerUserId !== null &&
      viewerUserId !== targetUserId &&
      (await this.isBlockedEitherWay(viewerUserId, targetUserId))
    ) {
      return [];
    }
    const rows = await this.prisma.giftPost.findMany({
      where: {
        ownerUserId: targetUserId,
        publishedAt: { not: null },
        visibility: 'public',
        deactivatedAt: null,
      },
      orderBy: { publishedAt: 'desc' },
      include: this.giftInclude(),
    });
    // Same dedup as listMine — collapse repeats by
    // (ownerUserId, direction, productId), keep the most recent
    // representative, surface `eventCount` as a ×N badge on the
    // grid tile.
    const grouped = collapseGiftPostGroups(rows);
    return grouped.map(({ row, eventCount }) =>
      this.toView(row, viewerUserId, /* forceVisible */ false, eventCount),
    );
  }

  // /p/<slug> public route. Returns the privacy-masked view; throws
  // 404 when the slug doesn't exist OR the post is no longer publicly
  // viewable to the caller. We collapse "private" / "deactivated" /
  // "blocked" into the same 404 deliberately — the existence of a
  // private post (or a blocked-user's post) is itself information
  // we don't want to leak through 403s.
  async getBySlug(slug: string, viewerUserId: string | null) {
    const trimmed = slug?.trim();
    if (!trimmed) throw new NotFoundException('Post not found');
    const row = await this.prisma.giftPost.findUnique({
      where: { publicSlug: trimmed },
      include: this.giftInclude(),
    });
    if (!row) throw new NotFoundException('Post not found');
    const isOwner = viewerUserId !== null && row.ownerUserId === viewerUserId;
    const isGiftParty =
      viewerUserId !== null &&
      (viewerUserId === row.gift.senderId ||
        viewerUserId === row.gift.receiverId);
    // Block check — only when the viewer is authenticated AND is
    // NOT the owner / gift party (owner and gift parties always see
    // their own gift moment regardless of blocks).
    if (
      viewerUserId !== null &&
      !isOwner &&
      !isGiftParty &&
      (await this.isBlockedEitherWay(viewerUserId, row.ownerUserId))
    ) {
      throw new NotFoundException('Post not found');
    }
    const publiclyViewable =
      row.publishedAt !== null &&
      row.visibility === 'public' &&
      row.deactivatedAt === null;
    if (!publiclyViewable && !isOwner && !isGiftParty) {
      throw new NotFoundException('Post not found');
    }
    return this.toView(row, viewerUserId);
  }

  // Bidirectional block probe. Either user blocking the other
  // produces the same effect: the relationship is erased from the
  // viewer's experience. Single row read; the composite-PK index
  // on Block(blockerId, blockedId) covers both directions in a
  // single OR query.
  private async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const row = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
      select: { blockerId: true },
    });
    return row !== null;
  }

  // Fire an aggregate, identity-masked appreciation notification to
  // the post owner — but only when we haven't already notified them
  // in the current throttle window. Calm-by-default behavior per
  // `project_notification_channels_policy`: a burst of 👍s within
  // 24h generates ONE ping, not N.
  //
  // Privacy: notification body NEVER names the appreciator. The
  // post owner sees aggregate signal only. The link deep-links to
  // the post on the owner's profile so they can investigate at
  // their own pace; the appreciators list is never surfaced.
  //
  // Best-effort: a failure here never affects the appreciate
  // mutation. We log + swallow. The throttle check itself is a
  // single indexed row read on the Notification table — see the
  // composite (userId, type, createdAt) cardinality index notes
  // in `Notification` model.
  private async notifyAppreciationThrottled(
    ownerUserId: string,
    postId: string,
  ): Promise<void> {
    try {
      // Throttle probe — most recent notification of this type for
      // this post owner. We embed the postId in the `link` so the
      // probe can match without a join. Window is fixed
      // APPRECIATION_NOTIFY_WINDOW_MS; if the last ping is older
      // than that, we fire a fresh one.
      const linkMarker = this.appreciationNotificationLink(postId);
      const cutoff = new Date(Date.now() - APPRECIATION_NOTIFY_WINDOW_MS);
      const recent = await this.prisma.notification.findFirst({
        where: {
          userId: ownerUserId,
          type: NotificationType.GiftPostAppreciated,
          link: linkMarker,
          createdAt: { gte: cutoff },
        },
        select: { id: true },
      });
      if (recent) return; // already pinged in-window; stay silent
      void this.notifications.trigger({
        userId: ownerUserId,
        type: NotificationType.GiftPostAppreciated,
        // Aggregate, identity-masked copy. No appreciator name.
        // No count — the throttle means we'd often undercount, and
        // a vanity number is the engagement-farming pattern we're
        // explicitly avoiding.
        title: 'تم تقدير لحظة إهدائك 👍',
        body: null,
        link: linkMarker,
      });
    } catch (err) {
      this.logger.warn(
        `[gift-posts] appreciation notification failed for postId=${postId} ownerUserId=${ownerUserId}: ${(err as Error).message}`,
      );
    }
  }

  // Build the deep-link for an appreciation notification. Routes
  // to the post detail surface on the owner's own profile — they
  // can review there at their own pace. We embed `?post=<id>` so
  // the throttle probe can match on this exact value without a
  // separate "postId" column on Notification.
  private appreciationNotificationLink(postId: string): string {
    return `/profile?post=${encodeURIComponent(postId)}`;
  }

  // 👍 toggle. Returns the post-toggle state so the frontend can
  // optimistically flip the button without a second round-trip.
  // Uses a single transaction so the counter and the row stay in
  // lockstep — same invariant pattern as Wish + Product.wishlistedByCount.
  async appreciate(
    viewerUserId: string,
    postId: string,
  ): Promise<AppreciationToggleResult> {
    const post = await this.prisma.giftPost.findUnique({
      where: { id: postId },
      select: {
        id: true,
        ownerUserId: true,
        publishedAt: true,
        visibility: true,
        deactivatedAt: true,
        appreciationCount: true,
      },
    });
    if (!post) throw new NotFoundException('Post not found');
    // Self-appreciation is allowed conceptually but pointless and
    // visually noisy — block at the service level so the counter
    // reflects external approval only.
    if (post.ownerUserId === viewerUserId) {
      throw new BadRequestException('لا يمكنك تقدير منشورك الخاص');
    }
    // Can only appreciate a post that's actually visible. Match the
    // public-feed gate: published + public + not deactivated.
    const publiclyViewable =
      post.publishedAt !== null &&
      post.visibility === 'public' &&
      post.deactivatedAt === null;
    if (!publiclyViewable) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }

    // Race-safe toggle. Instead of read-then-write (where two
    // concurrent toggle calls could both find existing=null and
    // both try to create — second create would 500 on the unique
    // constraint), we attempt the create optimistically and catch
    // the unique-constraint error as the "already appreciated"
    // signal, then run the delete+decrement path. Same pattern
    // used elsewhere in the codebase for upsert-style toggles.
    //
    // The unique index on (giftPostId, userId) is the authoritative
    // race resolver — no two concurrent calls can both succeed.
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.giftPostAppreciation.create({
          data: { giftPostId: postId, userId: viewerUserId },
        });
        return tx.giftPost.update({
          where: { id: postId },
          data: { appreciationCount: { increment: 1 } },
          select: { appreciationCount: true },
        });
      });
      // Fire a notification to the post owner — calm + identity-
      // masked + throttled. Never blocks the appreciate result;
      // we don't await the call. Failure is logged inside the
      // helper and never surfaces to the user.
      void this.notifyAppreciationThrottled(post.ownerUserId, postId);
      return {
        appreciated: true,
        appreciationCount: updated.appreciationCount,
      };
    } catch (err) {
      // Prisma surface for "unique constraint violation" is
      // P2002. Treat as "already appreciated, so this call is the
      // un-appreciate gesture" and flip to the delete+decrement
      // path. Any other error re-throws unchanged.
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
    }

    // Un-appreciate path. Decrement the counter; clamp negatives
    // defensively in the response (the unique constraint and the
    // transactional create+increment make negatives near-impossible,
    // but the clamp is cheap insurance against any future drift).
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.giftPostAppreciation.delete({
        where: {
          giftPostId_userId: { giftPostId: postId, userId: viewerUserId },
        },
      });
      return tx.giftPost.update({
        where: { id: postId },
        data: { appreciationCount: { decrement: 1 } },
        select: { appreciationCount: true },
      });
    });
    const next = Math.max(0, updated.appreciationCount);
    if (updated.appreciationCount < 0) {
      this.logger.warn(
        `[gift-posts] negative appreciationCount on post ${postId}: ` +
          `${updated.appreciationCount} — clamped to 0 in response`,
      );
    }
    return { appreciated: false, appreciationCount: next };
  }

  // Look up the post for a specific gift, owned by the viewer. Used
  // by the gift-detail "Share this gift" CTA to pre-populate its
  // published/unpublished state without scanning the whole wall.
  // Returns null when there's no post yet (first-time publish).
  //
  // Composite-key lookup: each Gift can have UP TO TWO posts
  // (sender's + receiver's). We want only the viewer's own.
  async getMineByGift(viewerUserId: string, giftId: string) {
    const post = await this.prisma.giftPost.findUnique({
      where: {
        giftId_ownerUserId: { giftId, ownerUserId: viewerUserId },
      },
    });
    return post ?? null;
  }

  // Membership probe — drives the filled-vs-outline state of the 👍
  // button on the frontend without requiring the full post payload.
  async checkAppreciation(viewerUserId: string, postId: string) {
    const row = await this.prisma.giftPostAppreciation.findUnique({
      where: {
        giftPostId_userId: { giftPostId: postId, userId: viewerUserId },
      },
      select: { id: true },
    });
    return { appreciated: row !== null };
  }

  // ── internals ──────────────────────────────────────────────

  private giftInclude() {
    return {
      gift: {
        select: {
          id: true,
          senderId: true,
          receiverId: true,
          productId: true,
          storeId: true,
          productName: true,
          storeName: true,
          // Pull the product image + media gallery at view time.
          // Single-source-of-truth rule
          // (`project_product_media_single_source.md`): we read URL
          // pointers, never copy binaries. The `imageUrl` field is
          // the cached primary; the `images` relation is the
          // ordered gallery (added in Phase 4). For products
          // without explicit gallery rows, the projection falls
          // back to `[imageUrl]` in toView so the viewer's
          // horizontal-swipe behavior degrades to a single-image
          // slide cleanly.
          product: {
            select: {
              imageUrl: true,
              images: {
                select: { url: true, displayOrder: true },
                orderBy: { displayOrder: 'asc' },
              },
            },
          },
          sender: {
            select: { qiftUsername: true, fullName: true },
          },
          receiver: {
            select: { qiftUsername: true, fullName: true },
          },
        },
      },
    } as const;
  }

  // Wraps the shared visibility helper. `forceVisible=true` skips the
  // identity masking gate (owner viewing their own listMine wall sees
  // the full identity payload of both sides). External viewers always
  // route through buildGiftPostView with masking applied.
  private toView(
    row: Awaited<ReturnType<typeof this.fetchOne>>,
    viewerUserId: string | null,
    forceVisible = false,
    // Dedup-aware: when the row is a representative of a group of N
    // repeat gifts of the same product, `eventCount` is N. Default 1
    // (singleton — no dedup applied). The frontend grid renders a
    // ×N badge only when eventCount > 1; the viewer treats the row
    // as a normal individual post regardless.
    eventCount = 1,
  ): GiftPostView & {
    postId: string;
    ownerUserId: string;
    direction: string;
    appreciationCount: number;
    publicSlug: string | null;
    eventCount: number;
  } {
    if (!row) {
      throw new NotFoundException('Post not found');
    }
    const base = buildGiftPostView({
      post: {
        id: row.id,
        visibility: row.visibility,
        revealSender: row.revealSender,
        revealRecipient: row.revealRecipient,
        publishedAt: row.publishedAt,
        deactivatedAt: row.deactivatedAt,
      },
      gift: {
        productName: row.gift.productName,
        storeName: row.gift.storeName,
        productId: row.gift.productId ?? null,
        storeId: row.gift.storeId ?? null,
        productImageUrl: row.gift.product?.imageUrl ?? null,
        // Full ordered gallery for the viewer's horizontal swipe.
        // Falls back to the cached primary `imageUrl` when no
        // explicit ProductImage rows exist (legacy / freshly-
        // ingested products). Empty array when neither source
        // has a URL — the viewer renders the gradient fallback
        // tile in that case.
        productImages: deriveGallery(
          row.gift.product?.images,
          row.gift.product?.imageUrl,
        ),
        sender: row.gift.sender,
        receiver: row.gift.receiver,
      },
      viewerUserId: forceVisible ? row.ownerUserId : viewerUserId,
      senderUserId: row.gift.senderId,
      receiverUserId: row.gift.receiverId,
    });
    return {
      ...base,
      postId: row.id,
      ownerUserId: row.ownerUserId,
      direction: row.direction,
      appreciationCount: row.appreciationCount,
      publicSlug: row.publicSlug,
      eventCount,
    };
  }

  // Type helper so the toView typing matches the include shape.
  // Not called at runtime.
  private async fetchOne(id: string) {
    return this.prisma.giftPost.findUnique({
      where: { id },
      include: this.giftInclude(),
    });
  }

  private async requireOwnedPost(viewerUserId: string, postId: string) {
    const post = await this.prisma.giftPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.ownerUserId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return post;
  }

  // Narrow check for Prisma's unique-constraint violation. We don't
  // import the full Prisma error namespace to keep this module
  // dependency-light; checking the `code` field on the error object
  // is the documented contract and stable across minor Prisma
  // versions.
  // (Helper kept inside the class body so future toggles can share
  // it without exporting Prisma error plumbing module-wide.)

  // crypto-grade slug; collision-retry loop bounded so we never spin
  // forever in the pathological case.
  private async generateUniqueSlug(): Promise<string> {
    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
      const candidate = randomBytes(SLUG_BYTES)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const collision = await this.prisma.giftPost.findUnique({
        where: { publicSlug: candidate },
        select: { id: true },
      });
      if (!collision) return candidate;
    }
    // 2^96 namespace — hitting this branch means something is broken
    // upstream (e.g. randomBytes returning a constant in a test mock).
    throw new Error('Could not generate a unique gift-post slug');
  }
}

// Module-level helper so the toggle path can detect Prisma's
// unique-constraint violation without importing the full Prisma
// error class. The `code` field is part of the documented Prisma
// client error shape.
function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}

// Collapse rows that are repeat gifts of the same product by the
// same owner in the same direction into a single representative.
// V1 dedup is a query-layer concern (see `project_gift_post_dedup.md`
// + the 20260517 migration comment): each GiftPost row stays
// per-gift, but the wall surface presents at most ONE entry per
// (ownerUserId, direction, productId) bucket, with `eventCount`
// surfacing the bucket size for the ×N grid badge.
//
// Sort assumption: `rows` is pre-sorted with the most-recent
// post FIRST. The first row encountered per bucket becomes the
// representative; subsequent rows in the same bucket increment
// the count.
//
// Posts without a productId (legacy / sample-product gifts) are
// keyed by their post id so they NEVER collapse with anything —
// each free-text gift stands on its own.
function collapseGiftPostGroups<
  R extends {
    id: string;
    ownerUserId: string;
    direction: string;
    gift: { productId: string | null };
  },
>(rows: R[]): Array<{ row: R; eventCount: number }> {
  const groups = new Map<string, { row: R; eventCount: number }>();
  for (const r of rows) {
    const key = r.gift.productId
      ? `p|${r.ownerUserId}|${r.direction}|${r.gift.productId}`
      : `s|${r.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.eventCount += 1;
    } else {
      groups.set(key, { row: r, eventCount: 1 });
    }
  }
  // Preserve the input order (Map iteration order is insertion
  // order in modern JS). Since the input is already sorted by
  // publishedAt DESC, the output is also DESC.
  return Array.from(groups.values());
}

// Resolve the ordered gallery for a gift's product. Prefers the
// explicit `ProductImage` rows (the gallery added in Phase 4);
// falls back to the cached `Product.imageUrl` snapshot when no
// gallery rows exist (legacy products, or products that haven't
// uploaded multiple images yet). Returns an empty array when
// neither source has a URL.
//
// Dedup-aware: the cached `imageUrl` is intentionally NOT
// re-appended if it already appears as a gallery row — store-side
// writers are expected to keep `Product.imageUrl` in sync with the
// first ProductImage row (displayOrder = 0).
function deriveGallery(
  images: Array<{ url: string; displayOrder: number }> | null | undefined,
  cachedPrimary: string | null | undefined,
): string[] {
  const ordered = (images ?? [])
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((i) => i.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (ordered.length > 0) return ordered;
  if (cachedPrimary && cachedPrimary.length > 0) return [cachedPrimary];
  return [];
}
