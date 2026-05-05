import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CreateWishInput = {
  title?: string;
  store?: string;
  visibility?: string;
};

// PATCH body. All fields optional. `null` for `store` is meaningful — it
// clears the store. `undefined` (i.e. missing key) leaves the field
// untouched.
export type UpdateWishInput = {
  title?: string;
  store?: string | null;
  visibility?: string;
};

// Match the constraints already documented in the schema comment block on
// the Wish model. Length caps are app-layer; the column itself is plain
// TEXT.
const TITLE_MAX = 120;
const STORE_MAX = 80;

const VISIBILITY_VALUES = ['public', 'private'] as const;
type Visibility = (typeof VISIBILITY_VALUES)[number];

function normalizeVisibility(raw: string | undefined): Visibility {
  return (VISIBILITY_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as Visibility)
    : 'public';
}

@Injectable()
export class WishesService {
  constructor(private prisma: PrismaService) {}

  // POST /wishes
  // The endpoint takes the actor's user id from the JWT and writes a Wish
  // row owned by them. There is no `userId` field in the body — clients
  // cannot create wishes on behalf of someone else.
  async create(userId: string, body: CreateWishInput) {
    const title = body.title?.trim();
    if (!title) {
      throw new BadRequestException('title is required');
    }
    if (title.length > TITLE_MAX) {
      throw new BadRequestException(`title must be at most ${TITLE_MAX} chars`);
    }

    const store = body.store?.trim() || null;
    if (store && store.length > STORE_MAX) {
      throw new BadRequestException(`store must be at most ${STORE_MAX} chars`);
    }

    const visibility = normalizeVisibility(body.visibility);

    // Idempotency: if this user already has a wish with the same trimmed
    // title and the same store (NULL vs string is significant), return
    // the existing row instead of creating a duplicate. Notably we DO
    // NOT update the existing row's visibility — "add to wishlist" is
    // not supposed to silently mutate something the user has already
    // configured (e.g. flip private → public).
    //
    // Match semantics:
    //   - title: trimmed, case-sensitive equality.
    //   - store: NULL on both sides matches; otherwise trimmed,
    //     case-sensitive equality. SQLite's default collation gives us
    //     case-sensitive comparison out of the box.
    //
    // Race-condition note: two simultaneous POSTs with identical payload
    // could both pass this check and create two rows. For now this is
    // acceptable (the user-facing button has a `wishBusy` guard on the
    // frontend, and dev traffic is single-user). When multi-user load
    // matters, add a unique index on (userId, title, store) and catch
    // Prisma's P2002 in this method.
    const existing = await this.prisma.wish.findFirst({
      where: { userId, title, store },
      select: {
        id: true,
        title: true,
        store: true,
        visibility: true,
        createdAt: true,
      },
    });
    if (existing) return existing;

    return this.prisma.wish.create({
      data: {
        userId,
        title,
        store,
        visibility,
      },
      // Selective return — same shape the public profile / owner UI both
      // use. Excludes userId since that's the caller themselves.
      select: {
        id: true,
        title: true,
        store: true,
        visibility: true,
        createdAt: true,
      },
    });
  }

  // PATCH /wishes/:id — partial update of an existing wish.
  //
  // Ownership is enforced server-side: the wish must exist AND its userId
  // must match the JWT subject. Otherwise 404 — we deliberately don't
  // distinguish "not found" from "not yours" to avoid leaking the
  // existence of other users' wishes via probes against the wish-id space.
  //
  // Field semantics (PATCH, not PUT):
  //   - title       missing  → unchanged. provided → must be non-empty.
  //   - store       missing  → unchanged. null     → cleared.
  //                 provided as string → set (validated, trimmed).
  //   - visibility  missing  → unchanged. provided → 'public' | 'private'.
  async update(userId: string, id: string, body: UpdateWishInput) {
    const existing = await this.prisma.wish.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('wish_not_found');

    const data: Prisma.WishUpdateInput = {};

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) {
        throw new BadRequestException('title is required');
      }
      if (title.length > TITLE_MAX) {
        throw new BadRequestException(
          `title must be at most ${TITLE_MAX} chars`,
        );
      }
      data.title = title;
    }

    if (body.store !== undefined) {
      const store = body.store?.trim() || null;
      if (store && store.length > STORE_MAX) {
        throw new BadRequestException(
          `store must be at most ${STORE_MAX} chars`,
        );
      }
      data.store = store;
    }

    if (body.visibility !== undefined) {
      data.visibility = normalizeVisibility(body.visibility);
    }

    return this.prisma.wish.update({
      where: { id },
      data,
      select: {
        id: true,
        title: true,
        store: true,
        visibility: true,
        createdAt: true,
      },
    });
  }

  // DELETE /wishes/:id — same ownership rule as update.
  async remove(userId: string, id: string) {
    const existing = await this.prisma.wish.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('wish_not_found');

    await this.prisma.wish.delete({ where: { id } });
    return { ok: true as const };
  }

  // GET /wishes/me — owner's complete wishlist.
  //
  // Includes both public AND private wishes since the caller is the owner.
  // Public profile (/users/:userId/wishes) filters to public-only and
  // applies privacy gating; this endpoint does neither because the caller
  // owns every row by construction.
  //
  // Newest first (matches the on-disk index `(userId, visibility, createdAt)`
  // declared in schema.prisma).
  async listMine(userId: string) {
    const items = await this.prisma.wish.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        store: true,
        visibility: true,
        createdAt: true,
      },
    });
    return { items, total: items.length };
  }
}
