import {
  BadRequestException,
  ConflictException,
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

@Injectable()
export class GiftPostsService {
  private readonly logger = new Logger(GiftPostsService.name);

  constructor(private prisma: PrismaService) {}

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

    // GiftPost is keyed on giftId @unique — one post per gift.
    // Each side (sender / receiver) gets their own row only when we
    // ship receiver-side publishing; for now the row is the producer
    // side. We surface a friendly 409 if the OTHER side already
    // published this gift — the V1 UI doesn't yet show "the other
    // party already shared this", but we don't want to silently
    // overwrite their visibility setting either.
    const existing = await this.prisma.giftPost.findUnique({
      where: { giftId },
    });
    if (existing && existing.ownerUserId !== viewerUserId) {
      throw new ConflictException('الطرف الآخر شارك هذه الهدية بالفعل');
    }

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
    return rows.map((row) =>
      this.toView(row, viewerUserId, /* forceVisible */ true),
    );
  }

  // Public Gift Wall for /u/<username>. Filters down to published +
  // public + not-deactivated posts. Owner viewing their own wall via
  // this endpoint sees the same filter — they have listMine() for
  // their full wall.
  async listByUser(targetUserId: string, viewerUserId: string | null) {
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
    return rows.map((row) => this.toView(row, viewerUserId));
  }

  // /p/<slug> public route. Returns the privacy-masked view; throws
  // 404 when the slug doesn't exist OR the post is no longer publicly
  // viewable to the caller. We collapse "private" and "deactivated"
  // into the same 404 deliberately — the existence of a private post
  // is itself information we don't want to leak through 403s.
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
    const publiclyViewable =
      row.publishedAt !== null &&
      row.visibility === 'public' &&
      row.deactivatedAt === null;
    if (!publiclyViewable && !isOwner && !isGiftParty) {
      throw new NotFoundException('Post not found');
    }
    return this.toView(row, viewerUserId);
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

    const existing = await this.prisma.giftPostAppreciation.findUnique({
      where: {
        giftPostId_userId: { giftPostId: postId, userId: viewerUserId },
      },
    });

    if (existing) {
      // Un-appreciate path. Decrement the counter, clamping at zero
      // defensively (the unique constraint plus this branch means we
      // should never go negative, but the clamp is cheap).
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.giftPostAppreciation.delete({
          where: { id: existing.id },
        });
        return tx.giftPost.update({
          where: { id: postId },
          data: { appreciationCount: { decrement: 1 } },
          select: { appreciationCount: true },
        });
      });
      const next = Math.max(0, updated.appreciationCount);
      // If we ever go negative, log + heal (the transaction is what
      // it is — we can't un-decrement here without another round-trip,
      // so just log and clamp the response).
      if (updated.appreciationCount < 0) {
        this.logger.warn(
          `[gift-posts] negative appreciationCount on post ${postId}: ` +
            `${updated.appreciationCount} — clamped to 0 in response`,
        );
      }
      return { appreciated: false, appreciationCount: next };
    }

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
    return {
      appreciated: true,
      appreciationCount: updated.appreciationCount,
    };
  }

  // Look up the post for a specific gift, owned by the viewer. Used
  // by the gift-detail "Share this gift" CTA to pre-populate its
  // published/unpublished state without scanning the whole wall.
  // Returns null when there's no post yet (V1 first-time publish).
  async getMineByGift(viewerUserId: string, giftId: string) {
    const post = await this.prisma.giftPost.findUnique({
      where: { giftId },
    });
    if (!post) return null;
    // Privacy: only the owner can probe their own post. We do NOT
    // surface the existence of another user's post here — same
    // 404-as-collapsed-state pattern as getBySlug for non-owners.
    if (post.ownerUserId !== viewerUserId) return null;
    return post;
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
  ): GiftPostView & {
    postId: string;
    ownerUserId: string;
    direction: string;
    appreciationCount: number;
    publicSlug: string | null;
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
