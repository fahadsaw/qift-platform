import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Allow-list of platforms the UI knows how to render. Anything else is
// rejected at the API layer so a malicious client can't smuggle in a
// platform key the rest of the app doesn't expect.
const ALLOWED_PLATFORMS = new Set([
  'snapchat',
  'tiktok',
  'instagram',
  'x',
  'facebook',
  'youtube',
  'threads',
  'telegram',
]);

const HANDLE_MAX = 80;

export type LinkInput = { platform?: string; handle?: string };
export type UpdateInput = { handle?: string };

// Public projection — what the public profile / search row actually
// renders. Excludes `userId` (caller already has it) and `verified`
// (always false in the manual-linking phase).
const PUBLIC_SELECT = {
  id: true,
  platform: true,
  handle: true,
  url: true,
  // Tri-state ownership signal. The frontend renders a "Verified" /
  // "Unverified" chip from this — keep it surfaced even while we still
  // emit the legacy `verified` boolean for older clients.
  verificationLevel: true,
  verified: true,
  isPrimary: true,
  createdAt: true,
} as const;

// Exported so UsersService.searchUsers (and any future caller that
// needs to look a handle up by its canonical form) applies the EXACT
// same normalization used at write time. Without sharing this, a
// stored handle and a queried handle could subtly disagree on
// whitespace / case / @-prefix and the exact-match social search
// would miss valid hits.
export function normalizeHandle(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  // Strip leading @ + whitespace; collapse internal whitespace.
  // Lowercase to match the @@unique([platform, handle]) constraint
  // case-insensitively (DB collation is case-sensitive on Postgres).
  return raw.trim().replace(/^@+/, '').replace(/\s+/g, '').toLowerCase();
}

function normalizePlatform(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

@Injectable()
export class SocialAccountsService {
  constructor(private prisma: PrismaService) {}

  // POST /social-accounts — manual linking. Scoped to the JWT viewer.
  // We deliberately set verified: false regardless of what the client
  // sends — there's no OAuth round-trip yet, so we never claim a
  // social account is verified. The frontend must label rows as
  // "Unverified" until real OAuth is wired in.
  //
  // One row per (userId, platform): if the user already has a row for
  // this platform, the request is rejected with 409 and they're told
  // to PATCH instead. We could upsert silently but explicit is safer
  // (catches accidental double-submits in the form).
  async link(viewerUserId: string, body: LinkInput) {
    const platform = normalizePlatform(body.platform);
    const handle = normalizeHandle(body.handle);

    if (!ALLOWED_PLATFORMS.has(platform)) {
      throw new BadRequestException('platform_not_supported');
    }
    if (!handle) {
      throw new BadRequestException('handle_required');
    }
    if (handle.length > HANDLE_MAX) {
      throw new BadRequestException(
        `handle must be at most ${HANDLE_MAX} chars`,
      );
    }

    // Service-level uniqueness on (userId, platform). The DB has a
    // global @@unique([platform, handle]) but no per-user unique on
    // platform. Two-step check + create with try/catch on P2002 to
    // catch the global-handle collision case too.
    const existingForUser = await this.prisma.socialAccount.findFirst({
      where: { userId: viewerUserId, platform },
      select: { id: true },
    });
    if (existingForUser) {
      throw new ConflictException('account_for_platform_already_linked');
    }

    try {
      return await this.prisma.socialAccount.create({
        data: {
          userId: viewerUserId,
          platform,
          handle,
          // Manual links land at the new tri-state default. We set
          // both columns in lockstep until the legacy `verified`
          // boolean is removed in a follow-up cleanup PR.
          verified: false,
          verificationLevel: 'unverified',
          isPrimary: false,
        },
        select: PUBLIC_SELECT,
      });
    } catch (err) {
      // P2002: unique constraint failed (the global platform+handle).
      // Means another Qift user already linked this exact handle on
      // this platform. We don't reveal which user — just refuse.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('handle_already_taken');
      }
      throw err;
    }
  }

  // PATCH /social-accounts/:id — update the handle of an existing row.
  // Scoped to the JWT viewer (must own the row). Platform can't be
  // edited — to change platform, delete + re-link.
  async updateHandle(viewerUserId: string, id: string, body: UpdateInput) {
    const handle = normalizeHandle(body.handle);
    if (!handle) {
      throw new BadRequestException('handle_required');
    }
    if (handle.length > HANDLE_MAX) {
      throw new BadRequestException(
        `handle must be at most ${HANDLE_MAX} chars`,
      );
    }

    const existing = await this.prisma.socialAccount.findUnique({
      where: { id },
      select: { userId: true, platform: true },
    });
    if (!existing) throw new NotFoundException('account_not_found');
    if (existing.userId !== viewerUserId) {
      throw new ForbiddenException('not_owner');
    }

    try {
      return await this.prisma.socialAccount.update({
        where: { id },
        data: {
          handle,
          // Editing the handle invalidates any prior verification claim.
          // The new value needs its own proof of ownership.
          verified: false,
          verificationLevel: 'unverified',
        },
        select: PUBLIC_SELECT,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('handle_already_taken');
      }
      throw err;
    }
  }

  // DELETE /social-accounts/:id — remove a linked account.
  async unlink(viewerUserId: string, id: string) {
    const existing = await this.prisma.socialAccount.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!existing) throw new NotFoundException('account_not_found');
    if (existing.userId !== viewerUserId) {
      throw new ForbiddenException('not_owner');
    }
    await this.prisma.socialAccount.delete({ where: { id } });
    return { ok: true as const };
  }

  // GET /social-accounts/me — viewer's own list. Used by the manage
  // screen at /social-accounts.
  listMine(viewerUserId: string) {
    return this.prisma.socialAccount.findMany({
      where: { userId: viewerUserId },
      orderBy: { createdAt: 'asc' },
      select: PUBLIC_SELECT,
    });
  }

  // GET /social-accounts/:userId — public projection of a target
  // user's social accounts. Used by /u/[username]. The shape is the
  // same as listMine because nothing here is sensitive (handles are
  // already public-by-intent on the user's profile).
  findByUser(targetUserId: string) {
    return this.prisma.socialAccount.findMany({
      where: { userId: targetUserId },
      orderBy: { createdAt: 'asc' },
      select: PUBLIC_SELECT,
    });
  }
}
