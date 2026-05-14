import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BlocksService {
  constructor(private prisma: PrismaService) {}

  // POST /blocks/:userId — block a user.
  //
  // Idempotent: re-blocking is a no-op (composite PK on (blockerId,
  // blockedId) collapses duplicates). Self-blocking is a 400 — there's
  // no sensible interpretation. Blocking a deleted user is a 404 so the
  // UI can clean up dangling references.
  //
  // Side effect: when A blocks B, we also remove any Follow rows in
  // either direction. That's the "modern social app" expectation:
  // blocks supersede follows, and leaving them around makes the
  // followers-list filter logic gnarly downstream.
  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) {
      throw new BadRequestException('cannot_block_self');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: blockedId },
      select: { id: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      throw new NotFoundException('user_not_found');
    }

    await this.prisma.$transaction([
      this.prisma.block.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId },
        update: {},
      }),
      // Drop any follows in either direction. A future unblock is a
      // clean slate — the user has to re-follow if they want to.
      this.prisma.follow.deleteMany({
        where: {
          OR: [
            { followerId: blockerId, followingId: blockedId },
            { followerId: blockedId, followingId: blockerId },
          ],
        },
      }),
    ]);

    return { ok: true as const };
  }

  // DELETE /blocks/:userId — unblock. Idempotent: removing a block that
  // doesn't exist is a no-op (returns count: 0).
  async unblock(blockerId: string, blockedId: string) {
    const result = await this.prisma.block.deleteMany({
      where: { blockerId, blockedId },
    });
    return { ok: true as const, removed: result.count };
  }

  // GET /blocks/me — list of user IDs I've blocked. Used by the search
  // filter to exclude blocked users from results. We return just the
  // ids (not full user records) — the manage-blocks UI is a separate
  // PR; this endpoint is currently consumed only as a filter input.
  async listBlockedIds(viewerId: string): Promise<string[]> {
    const rows = await this.prisma.block.findMany({
      where: { blockerId: viewerId },
      select: { blockedId: true },
    });
    return rows.map((r) => r.blockedId);
  }

  // Private helper consumed by UsersService.searchUsers and the
  // public-profile gate. Returns the union of:
  //   - users I blocked
  //   - users who blocked me
  // so search + profile views hide them in BOTH directions.
  async listExcludedIds(viewerId: string): Promise<string[]> {
    const [out, inn] = await Promise.all([
      this.prisma.block.findMany({
        where: { blockerId: viewerId },
        select: { blockedId: true },
      }),
      this.prisma.block.findMany({
        where: { blockedId: viewerId },
        select: { blockerId: true },
      }),
    ]);
    const set = new Set<string>();
    for (const r of out) set.add(r.blockedId);
    for (const r of inn) set.add(r.blockerId);
    return Array.from(set);
  }

  // Point-check shortcut: is there a block in EITHER direction
  // between `viewerId` and `otherId`? Cheaper than listExcludedIds
  // when the caller only needs a single yes/no (a Block.findFirst
  // with an OR against the composite-PK columns is one indexed
  // query). Used by every "give me one specific user's data"
  // endpoint — public profile, follower/following lists, wishlist,
  // gift history.
  //
  // self-check short-circuits: a user can't block themselves
  // (the BadRequestException in block() prevents it) so the
  // viewer can always see their own data.
  async isBlockedEitherWay(
    viewerId: string,
    otherId: string,
  ): Promise<boolean> {
    if (viewerId === otherId) return false;
    const row = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: otherId },
          { blockerId: otherId, blockedId: viewerId },
        ],
      },
      // Block has a composite PK (blockerId, blockedId) — no `id`
      // column. Select one FK to get a truthy result without
      // dragging extra fields.
      select: { blockerId: true },
    });
    return row !== null;
  }
}
