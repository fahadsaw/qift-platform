import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from '../blocks/blocks.service';
import { RateLimiter } from '../common/rate-limiter';

// Per-actor follow rate limit: 30 follow/unfollow actions per minute.
// Idempotent re-follow doesn't add a row but still costs a hit; that's
// fine — we want to throttle the action, not the data shape. Tuned
// generous enough that scrolling-through-search-and-tapping-follow
// behaves naturally; tight enough that scripted abuse hits the wall.
const followLimiter = new RateLimiter(30, 60 * 1000);

// Whitelist of fields shipped over the wire for follower / following rows.
// Mirrors the response shape the frontend SocialListModal already consumes
// (id, fullName, qiftUsername, avatarUrl).
const SOCIAL_USER_SELECT = {
  id: true,
  fullName: true,
  qiftUsername: true,
  avatarUrl: true,
} as const;

export type SocialUser = {
  id: string;
  fullName: string | null;
  qiftUsername: string;
  avatarUrl: string | null;
};

export type SocialList = {
  items: SocialUser[];
  total: number;
};

@Injectable()
export class FollowsService {
  constructor(
    private prisma: PrismaService,
    private blocks: BlocksService,
  ) {}

  // POST /follow/:userId
  // Idempotent: re-following an already-followed user is a no-op (returns
  // the existing relationship). For private targets the follow is created
  // in 'pending' status so a future approval flow can accept it; public
  // targets transition straight to 'accepted'.
  async follow(actorId: string, targetUserId: string) {
    if (actorId === targetUserId) {
      throw new BadRequestException('cannot_follow_self');
    }
    if (!followLimiter.hit(`follow:${actorId}`)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'follow_rate_limited',
          message: 'Too many follow actions — slow down for a moment',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: { id: true, profileVisibility: true },
    });
    if (!target) throw new NotFoundException('user_not_found');

    const status =
      target.profileVisibility === 'private' ? 'pending' : 'accepted';
    const acceptedAt = status === 'accepted' ? new Date() : null;

    // upsert with empty update = idempotent create. The composite primary
    // key (followerId, followingId) makes this safe against duplicates.
    const follow = await this.prisma.follow.upsert({
      where: {
        followerId_followingId: {
          followerId: actorId,
          followingId: targetUserId,
        },
      },
      create: {
        followerId: actorId,
        followingId: targetUserId,
        status,
        acceptedAt,
      },
      update: {},
      select: { status: true, createdAt: true },
    });

    return {
      ok: true as const,
      status: follow.status,
      createdAt: follow.createdAt,
    };
  }

  // DELETE /follow/:userId
  // Idempotent: unfollowing someone you don't follow is also a 200.
  async unfollow(actorId: string, targetUserId: string) {
    if (actorId === targetUserId) {
      throw new BadRequestException('cannot_unfollow_self');
    }
    if (!followLimiter.hit(`follow:${actorId}`)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'follow_rate_limited',
          message: 'Too many follow actions — slow down for a moment',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.prisma.follow.deleteMany({
      where: {
        followerId: actorId,
        followingId: targetUserId,
      },
    });

    return { ok: true as const };
  }

  // GET /users/:userId/followers
  // Returns users who follow `targetUserId`, newest first, accepted-only.
  // Excludes soft-deleted accounts on both sides (the target must exist
  // and be live; deleted followers don't appear in the list).
  //
  // Privacy gates (added in the QA audit pass):
  //   - block list (either direction)         → 404 user_not_found
  //   - target.profileVisibility === 'private' → 403 hidden
  //   - target.showFollowers === false         → 403 hidden
  //   - each returned row is also filtered against the viewer's
  //     own block list so a blocked third-party doesn't appear in
  //     a target's follower list (a viewer should never see anyone
  //     they've blocked — and shouldn't be visible to anyone who
  //     blocked them — even when neither is the target).
  async listFollowers(
    viewerId: string,
    targetUserId: string,
  ): Promise<SocialList> {
    if (await this.blocks.isBlockedEitherWay(viewerId, targetUserId)) {
      throw new NotFoundException('user_not_found');
    }
    const target = await this.assertLiveUser(targetUserId);
    if (target.profileVisibility === 'private' || !target.showFollowers) {
      throw new ForbiddenException('followers_hidden');
    }

    const rows = await this.prisma.follow.findMany({
      where: {
        followingId: targetUserId,
        status: 'accepted',
        follower: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { follower: { select: SOCIAL_USER_SELECT } },
    });

    const excludedIds = new Set(await this.blocks.listExcludedIds(viewerId));
    const items = rows
      .map((r) => r.follower)
      .filter((u) => !excludedIds.has(u.id));
    return { items, total: items.length };
  }

  // GET /users/:userId/following
  // Returns users `targetUserId` is following, newest first, accepted-only.
  // Same soft-delete + privacy + block-list filtering as listFollowers.
  async listFollowing(
    viewerId: string,
    targetUserId: string,
  ): Promise<SocialList> {
    if (await this.blocks.isBlockedEitherWay(viewerId, targetUserId)) {
      throw new NotFoundException('user_not_found');
    }
    const target = await this.assertLiveUser(targetUserId);
    if (target.profileVisibility === 'private' || !target.showFollowing) {
      throw new ForbiddenException('following_hidden');
    }

    const rows = await this.prisma.follow.findMany({
      where: {
        followerId: targetUserId,
        status: 'accepted',
        following: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { following: { select: SOCIAL_USER_SELECT } },
    });

    const excludedIds = new Set(await this.blocks.listExcludedIds(viewerId));
    const items = rows
      .map((r) => r.following)
      .filter((u) => !excludedIds.has(u.id));
    return { items, total: items.length };
  }

  // Throws 404 when the target user doesn't exist or has been soft-deleted.
  // Returns the target's privacy flags so listFollowers / listFollowing
  // can gate on `profileVisibility` and `showFollowers` /
  // `showFollowing` without a second round-trip.
  private async assertLiveUser(userId: string): Promise<{
    id: string;
    profileVisibility: string;
    showFollowers: boolean;
    showFollowing: boolean;
  }> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        profileVisibility: true,
        showFollowers: true,
        showFollowing: true,
      },
    });
    if (!target) throw new NotFoundException('user_not_found');
    return target;
  }
}
