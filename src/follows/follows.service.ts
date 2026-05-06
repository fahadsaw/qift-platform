import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(private prisma: PrismaService) {}

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
  async listFollowers(targetUserId: string): Promise<SocialList> {
    await this.assertLiveUser(targetUserId);

    const rows = await this.prisma.follow.findMany({
      where: {
        followingId: targetUserId,
        status: 'accepted',
        follower: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { follower: { select: SOCIAL_USER_SELECT } },
    });

    const items = rows.map((r) => r.follower);
    return { items, total: items.length };
  }

  // GET /users/:userId/following
  // Returns users `targetUserId` is following, newest first, accepted-only.
  // Same soft-delete filtering as listFollowers.
  async listFollowing(targetUserId: string): Promise<SocialList> {
    await this.assertLiveUser(targetUserId);

    const rows = await this.prisma.follow.findMany({
      where: {
        followerId: targetUserId,
        status: 'accepted',
        following: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { following: { select: SOCIAL_USER_SELECT } },
    });

    const items = rows.map((r) => r.following);
    return { items, total: items.length };
  }

  // Throws 404 when the target user doesn't exist or has been soft-deleted.
  // Used as a guard at the start of the listing endpoints so callers can't
  // probe deleted accounts.
  private async assertLiveUser(userId: string): Promise<void> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
  }
}
