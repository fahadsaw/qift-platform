import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TRENDING_HEART_THRESHOLD } from '../products/storefront-metrics';

// Input shapes. The wishlist supports TWO heart paths:
//
//   1. Product-linked heart (preferred):
//        { productId, storeId } + optional snapshot fields.
//        The writer snapshots productName / storeName / imageUrl /
//        price / currency from the joined Product + Store at
//        heart-time so the wishlist card stays renderable even
//        if the underlying Product is later edited or
//        deactivated.
//
//   2. Legacy free-text wish (preserved):
//        { title, store? } only — same shape the original
//        free-text wishlist accepted. New code shouldn't write
//        these; existing callers continue to work.
//
// Either path is allowed in CreateWishInput. If productId is
// present, the writer uses the upsert-on-(userId, productId)
// path and ignores the legacy `title` input (the
// productName from the snapshot becomes the title).
export type CreateWishInput = {
  // Product-linked path:
  productId?: string;
  storeId?: string;
  productName?: string;
  storeName?: string;
  imageUrl?: string;
  price?: number;
  currency?: string;
  // Legacy free-text path:
  title?: string;
  store?: string;
  // Shared:
  visibility?: string;
};

export type UpdateWishInput = {
  title?: string;
  store?: string | null;
  visibility?: string;
};

// Field caps. Same as before — the upsert path snapshots
// productName into `title` so the cap applies to both.
const TITLE_MAX = 120;
const STORE_MAX = 80;

const VISIBILITY_VALUES = ['public', 'private'] as const;
type Visibility = (typeof VISIBILITY_VALUES)[number];

function normalizeVisibility(raw: string | undefined): Visibility {
  return (VISIBILITY_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as Visibility)
    : 'public';
}

// Public-safe wish projection. Returned by every endpoint that
// surfaces a wish. Includes the snapshot fields so the frontend
// can render rich cards without re-joining.
const WISH_SELECT = {
  id: true,
  title: true,
  store: true,
  productId: true,
  storeId: true,
  productName: true,
  storeName: true,
  imageUrl: true,
  price: true,
  currency: true,
  visibility: true,
  deactivatedAt: true,
  deactivatedReason: true,
  createdAt: true,
} satisfies Prisma.WishSelect;

@Injectable()
export class WishesService {
  constructor(private prisma: PrismaService) {}

  // POST /wishes
  //
  // Two paths:
  //   A. productId provided → product-linked upsert.
  //      - Looks up Product (for the snapshot fallback) + Store.
  //      - Upserts on (userId, productId) — re-hearting the same
  //        product is a no-op for row identity; it just refreshes
  //        the snapshot fields.
  //      - On NEW row creation, increments
  //        Product.wishlistedByCount atomically.
  //      - On existing-row update, count stays — the user already
  //        hearted this product before.
  //   B. No productId → legacy free-text wish.
  //      - Same idempotency-by-(title, store) behavior as before.
  //
  // Both paths return the same WISH_SELECT shape so callers don't
  // branch on the response.
  async create(userId: string, body: CreateWishInput) {
    const visibility = normalizeVisibility(body.visibility);
    const productId = body.productId?.trim();

    // Path A: product-linked heart.
    if (productId) {
      // Resolve the live Product + Store for snapshot fallback. The
      // request body may already carry productName/storeName/etc.
      // (the storefront has them), but we always reconcile with the
      // DB so a stale client can't poison the snapshot.
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          imageUrl: true,
          price: true,
          storeId: true,
          store: { select: { id: true, name: true } },
        },
      });
      if (!product) {
        throw new NotFoundException('product_not_found');
      }

      const snapshot = {
        productName: product.name,
        storeName: product.store?.name ?? body.storeName?.trim() ?? null,
        imageUrl: product.imageUrl ?? body.imageUrl?.trim() ?? null,
        price: product.price,
        currency: (body.currency ?? 'SAR').trim() || 'SAR',
      };
      const storeId = product.storeId ?? body.storeId?.trim() ?? null;
      // Mirror productName → title so legacy /wishes/me consumers
      // keep showing something sensible.
      const title = snapshot.productName.slice(0, TITLE_MAX);

      // Existence check before the upsert so we know whether to
      // increment the denormalized counter (only on insert, never
      // on update — re-hearting the same product must not double-
      // count).
      const existing = await this.prisma.wish.findUnique({
        where: { userId_productId: { userId, productId } },
        select: { id: true },
      });

      const wish = await this.prisma.wish.upsert({
        where: { userId_productId: { userId, productId } },
        create: {
          userId,
          productId,
          storeId,
          title,
          store: snapshot.storeName,
          productName: snapshot.productName,
          storeName: snapshot.storeName,
          imageUrl: snapshot.imageUrl,
          price: snapshot.price,
          currency: snapshot.currency,
          visibility,
        },
        update: {
          // Refresh the snapshot on every heart-tap so the wishlist
          // card reflects the latest product state when the user
          // re-engages.
          productName: snapshot.productName,
          storeName: snapshot.storeName,
          imageUrl: snapshot.imageUrl,
          price: snapshot.price,
          currency: snapshot.currency,
          title,
          store: snapshot.storeName,
          // Visibility is intentionally NOT overwritten on
          // re-heart — the user may have privatized this row.
          // Clear the deactivation flag if the product is back
          // and the user is re-engaging.
          deactivatedAt: null,
          deactivatedReason: null,
        },
        select: WISH_SELECT,
      });

      // Counter bump only on INSERT (existing was null).
      if (!existing) {
        const updated = await this.prisma.product.update({
          where: { id: productId },
          data: { wishlistedByCount: { increment: 1 } },
          select: { wishlistedByCount: true },
        });
        // Phase 5: trending heart-velocity hook. Once a product
        // is above the threshold, every new heart bumps the
        // trending timestamp so "recently active" products
        // surface. We update OUTSIDE the increment so the read
        // already sees the post-increment value.
        //
        // We don't run this for the very first hearts on a brand-
        // new product (below the threshold) — a single signal
        // shouldn't trigger a "trending" badge on the storefront,
        // and avoiding the write keeps the hot path lean. Once
        // the bar is cleared, every subsequent heart keeps the
        // timestamp fresh, so a product stays flagged as long as
        // engagement continues within the TRENDING_WINDOW.
        if (updated.wishlistedByCount >= TRENDING_HEART_THRESHOLD) {
          // Non-fatal — the heart succeeded; failing to update
          // the trending timestamp just means the badge lags by
          // one event. The projection still respects visibility.
          try {
            await this.prisma.product.update({
              where: { id: productId },
              data: { trendingAt: new Date() },
            });
          } catch {
            /* counter bump succeeded; trending hint is best-effort */
          }
        }
      }

      return wish;
    }

    // Path B: legacy free-text wish.
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

    // Idempotency for the legacy path — same semantics as before.
    const existing = await this.prisma.wish.findFirst({
      where: { userId, title, store, productId: null },
      select: WISH_SELECT,
    });
    if (existing) return existing;

    return this.prisma.wish.create({
      data: { userId, title, store, visibility },
      select: WISH_SELECT,
    });
  }

  // PATCH /wishes/:id — partial update. Same ownership rule + same
  // field semantics as the legacy implementation. Snapshot fields
  // (productName / storeName / imageUrl / price / currency) are
  // not editable via PATCH — they're refreshed by re-hearting from
  // the product page.
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
      select: WISH_SELECT,
    });
  }

  // DELETE /wishes/:id — same ownership rule. Decrements the
  // Product counter on success when productId is set.
  async remove(userId: string, id: string) {
    const existing = await this.prisma.wish.findFirst({
      where: { id, userId },
      select: { id: true, productId: true },
    });
    if (!existing) throw new NotFoundException('wish_not_found');

    await this.prisma.wish.delete({ where: { id } });
    if (existing.productId) {
      // Decrement the product counter. Safe-floor at 0 via Math.max
      // shouldn't be necessary since we only decrement after a real
      // delete, but Prisma's `decrement` doesn't have a floor —
      // negative is mathematically possible if the upsert/delete
      // path is ever bypassed. Future hardening: a backfill query
      // that recomputes from COUNT(DISTINCT userId).
      await this.prisma.product.update({
        where: { id: existing.productId },
        data: { wishlistedByCount: { decrement: 1 } },
      });
    }
    return { ok: true as const };
  }

  // DELETE /wishes/by-product/:productId — convenience path so the
  // frontend ❤️ button can unheart without round-tripping for the
  // wish id first. Mirrors the upsert symmetry.
  async removeByProduct(userId: string, productId: string) {
    const existing = await this.prisma.wish.findUnique({
      where: { userId_productId: { userId, productId } },
      select: { id: true },
    });
    if (!existing) return { ok: true as const };
    await this.prisma.wish.delete({ where: { id: existing.id } });
    await this.prisma.product.update({
      where: { id: productId },
      data: { wishlistedByCount: { decrement: 1 } },
    });
    return { ok: true as const };
  }

  // GET /wishes/check?productId=… — lightweight "is this product
  // in viewer's wishlist?" query. Returns the wish id when present,
  // null otherwise. Drives the heart-button state on every
  // product surface; debounced batching is a future optimization
  // when the storefront grids grow.
  async checkMembership(userId: string, productId: string) {
    if (!productId) return { inWishlist: false as const };
    const row = await this.prisma.wish.findUnique({
      where: { userId_productId: { userId, productId } },
      select: { id: true },
    });
    return row
      ? { inWishlist: true as const, wishId: row.id }
      : { inWishlist: false as const };
  }

  // GET /wishes/me — owner's complete wishlist with snapshot
  // fields. Newest first. Includes both public AND private rows
  // since the caller owns every row.
  async listMine(userId: string) {
    const items = await this.prisma.wish.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: WISH_SELECT,
    });
    return { items, total: items.length };
  }
}
