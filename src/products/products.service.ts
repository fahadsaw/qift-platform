import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_STORE_STATUSES, StoresService } from '../stores/stores.service';
import {
  projectStorefrontMetrics,
  type ProjectedMetrics,
} from './storefront-metrics';

const PUBLIC_PRODUCT_SELECT = {
  id: true,
  storeId: true,
  name: true,
  price: true,
  imageUrl: true,
  // Phase 2.5a — optional product video. Surfaced on the wire so
  // the storefront renderer can opt in when the playback surface
  // ships (gated by NEXT_PUBLIC_PRODUCT_VIDEO_ENABLED on the
  // frontend). Backend writes are accepted today; render is
  // deferred.
  videoUrl: true,
  videoType: true,
  category: true,
  isFastDelivery: true,
  sourceType: true,
  externalProductId: true,
  stockStatus: true,
  isAvailable: true,
  lastSyncedAt: true,
  createdAt: true,
  // Phase 5 storefront gallery — ordered product media for the
  // theme's hero. The first row (displayOrder = 0) mirrors
  // `imageUrl`; downstream consumers that only need the primary
  // can keep reading `imageUrl`. The storefront theme renderer
  // uses the full list for galleries (perfumes, jewelry, gift
  // sets benefit most). No binary copy — URL pointers only.
  //
  // Phase 2.5a — `imageMeta` was added to ProductImage as
  // forward-compat shape (per-image dimensions / mime / alt
  // text). It's selected here so downstream consumers can begin
  // reading it when populated; the 2.5a upload path does NOT
  // populate it yet (server-side dimension extraction is
  // deferred until storefront gallery rendering needs it).
  images: {
    select: { url: true, displayOrder: true, imageMeta: true },
    orderBy: { displayOrder: 'asc' as const },
  },
  // Phase 5 metrics-on-the-wire — denormalized counters + the
  // trending timestamp. The projection helper
  // `projectStorefrontMetrics` is the SINGLE place where these
  // raw values get converted into the merchant-approved sparse
  // dict that reaches the wire. Hidden keys never ship.
  wishlistedByCount: true,
  giftedByCount: true,
  trendingAt: true,
} as const;

// Raw Product row as selected above. Used by the metric
// projector + adapter helpers below.
type RawProductRow = {
  id: string;
  storeId: string;
  name: string;
  price: number;
  imageUrl: string | null;
  videoUrl: string | null;
  videoType: string | null;
  category: string;
  isFastDelivery: boolean;
  sourceType: string;
  externalProductId: string | null;
  stockStatus: string;
  isAvailable: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  images: {
    url: string;
    displayOrder: number;
    imageMeta: unknown;
  }[];
  wishlistedByCount: number;
  giftedByCount: number;
  trendingAt: Date | null;
};

// Public product wire-format. The raw counter columns + trending
// timestamp are intentionally DROPPED at this boundary — only the
// merchant-projected `metrics` dict (possibly undefined) makes it
// out. This guarantees that even if a future caller forgets to
// project, the raw values aren't exposed.
export type PublicProduct = Omit<
  RawProductRow,
  'wishlistedByCount' | 'giftedByCount' | 'trendingAt'
> & {
  metrics?: ProjectedMetrics;
};

// Strip the raw counter columns + apply the merchant's
// visibility projection. Used by both list() and findOne() so
// the projection logic stays in one place.
function toPublic(
  product: RawProductRow,
  storeVisibility: unknown,
  now: Date = new Date(),
): PublicProduct {
  const { wishlistedByCount, giftedByCount, trendingAt, ...rest } = product;
  const metrics = projectStorefrontMetrics(
    { wishlistedByCount, giftedByCount, trendingAt },
    storeVisibility,
    now,
  );
  return metrics === undefined ? rest : { ...rest, metrics };
}

export type CreateProductInput = {
  storeId?: string;
  name?: string;
  price?: number | string;
  // Legacy single-image field. Kept on the input surface for
  // backward compat with the URL-paste flow on the old
  // ProductModal and any external API integration that already
  // posts here. When `imageUrls` is ALSO provided, the
  // imageUrls[0] wins — the gallery is the source of truth and
  // imageUrl gets re-derived from imageUrls[0] in the service
  // body.
  imageUrl?: string | null;
  // Phase 2.5a — ordered gallery of product image URLs.
  // - First entry = primary; mirrored into `imageUrl` for
  //   backward compat with legacy consumers.
  // - Capped at MAX_PRODUCT_IMAGES.
  // - URLs are expected to come from POST /media/product-image
  //   (R2 public URLs); the legacy URL-paste path still accepts
  //   external http/https URLs for the same reason imageUrl
  //   does — closed beta doesn't enforce R2-only writes.
  // - Passing an EMPTY array clears the gallery (and the
  //   denormalised imageUrl). Passing `undefined` leaves the
  //   gallery untouched (PATCH semantics).
  imageUrls?: string[];
  // Phase 2.5a — optional product video. Backend accepts writes
  // during closed beta but no playback surface ships yet. videoType
  // is required when videoUrl is set; passing one without the
  // other throws BadRequestException so we never persist a
  // half-defined video reference.
  videoUrl?: string | null;
  videoType?: 'mp4' | 'webm' | 'mov' | null;
  category?: string;
  isFastDelivery?: boolean;
  stockStatus?: 'in_stock' | 'out_of_stock';
};

export type UpdateProductInput = Partial<CreateProductInput> & {
  isAvailable?: boolean;
};

// Cap on the number of product images per product. Chosen to match
// common e-commerce ceilings (Etsy: 10, Shopify: 250 per product
// but recommends ≤8). Closed beta starts conservative — the limit
// can be raised in a config without a schema migration.
const MAX_PRODUCT_IMAGES = 8;

// Validate + normalise an imageUrls input. Returns the cleaned
// array (trimmed, deduplicated by URL while preserving order,
// capped). Rejects payloads larger than the cap so a tampered
// client can't fill ProductImage with thousands of rows.
//
// URL validation: we accept http/https URLs only. Closed beta
// stays permissive about which origin (R2 + the legacy URL-paste
// fallback), but pathologically-long URLs are refused with a
// stable 400 — ProductImage.url is TEXT, but downstream
// consumers (storefront render) assume reasonable lengths.
function normaliseImageUrls(input: string[] | undefined): string[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input)) {
    throw new BadRequestException('imageUrls must be an array of strings');
  }
  if (input.length > MAX_PRODUCT_IMAGES) {
    throw new BadRequestException(
      `imageUrls supports at most ${MAX_PRODUCT_IMAGES} entries`,
    );
  }
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new BadRequestException('imageUrls entries must be strings');
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new BadRequestException(
        'imageUrls entries must be http or https URLs',
      );
    }
    if (trimmed.length > 1024) {
      throw new BadRequestException('imageUrls entry exceeds 1024 chars');
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

// Validate the (videoUrl, videoType) pair. Both null/undefined =
// no video. Both set = persist. Exactly one set = 400 (we never
// persist a half-defined video reference).
function normaliseVideo(
  videoUrl: string | null | undefined,
  videoType: 'mp4' | 'webm' | 'mov' | null | undefined,
): { videoUrl: string | null; videoType: string | null } | null {
  // Both undefined → caller didn't touch the video fields. Return
  // null to signal "no-op" to the caller.
  if (videoUrl === undefined && videoType === undefined) return null;
  const url =
    typeof videoUrl === 'string' && videoUrl.trim() ? videoUrl.trim() : null;
  const type =
    videoType === 'mp4' || videoType === 'webm' || videoType === 'mov'
      ? videoType
      : null;
  if ((url && !type) || (type && !url)) {
    throw new BadRequestException(
      'videoUrl and videoType must be provided together',
    );
  }
  if (url && url.length > 1024) {
    throw new BadRequestException('videoUrl exceeds 1024 chars');
  }
  if (url && !/^https?:\/\//i.test(url)) {
    throw new BadRequestException('videoUrl must be an http or https URL');
  }
  return { videoUrl: url, videoType: type };
}

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private stores: StoresService,
  ) {}

  // Manual create. Source-of-truth flag is hard-coded `manual` here —
  // synced products come in via StoreIntegrationsService.applySyncBatch.
  // We re-validate ownership of the target store so a malicious client
  // can't seed products into someone else's catalog.
  async create(viewerUserId: string, body: CreateProductInput) {
    const storeId = body.storeId?.trim();
    const name = body.name?.trim();
    const category = body.category?.trim();
    if (!storeId || !name || !category) {
      throw new BadRequestException('storeId, name and category are required');
    }
    const price = parsePrice(body.price);
    if (price == null) {
      throw new BadRequestException('price must be a non-negative number');
    }
    await this.stores.assertOwner(viewerUserId, storeId);

    // Phase 2.5a — validate + normalise the gallery + video
    // inputs up front. Both throw BadRequestException on malformed
    // input so the caller gets a clean 400 instead of a Prisma
    // constraint error.
    const imageUrls = normaliseImageUrls(body.imageUrls);
    const video = normaliseVideo(body.videoUrl, body.videoType);

    // Resolve the denormalised `imageUrl` column. Three sources,
    // in priority order:
    //   1. imageUrls[0]  — the new gallery's primary wins.
    //   2. body.imageUrl — legacy URL-paste path (kept for
    //                      backward compat).
    //   3. null          — neither provided.
    // This means a client posting BOTH `imageUrl` AND `imageUrls`
    // gets imageUrls[0] in the legacy field — predictable, and the
    // gallery is the new source of truth.
    const denormalisedImageUrl =
      imageUrls && imageUrls.length > 0
        ? imageUrls[0]
        : body.imageUrl?.trim() || null;

    const created = await this.prisma.product.create({
      data: {
        storeId,
        name,
        price,
        category,
        imageUrl: denormalisedImageUrl,
        isFastDelivery: body.isFastDelivery === true,
        sourceType: 'manual',
        stockStatus:
          body.stockStatus === 'out_of_stock' ? 'out_of_stock' : 'in_stock',
        isAvailable: true,
        // Video fields. `normaliseVideo` already enforced the
        // both-or-neither invariant — when it returns null the
        // caller didn't touch the fields, when it returns an
        // object the pair is consistent.
        ...(video !== null
          ? { videoUrl: video.videoUrl, videoType: video.videoType }
          : {}),
        // Gallery: create ProductImage rows inline using Prisma's
        // nested `create` on the Product.images relation. Safe
        // because the Product is brand-new — there are no
        // existing rows to conflict with on the @@unique
        // (productId, displayOrder) constraint.
        ...(imageUrls && imageUrls.length > 0
          ? {
              images: {
                create: imageUrls.map((url, idx) => ({
                  url,
                  displayOrder: idx,
                })),
              },
            }
          : {}),
      },
      select: PUBLIC_PRODUCT_SELECT,
    });
    // Brand-new product: no merchant could have opted any metric
    // for it yet, but route through `toPublic` anyway so the wire
    // shape stays consistent and the raw counter columns stay
    // stripped. Visibility is read from the parent store.
    const store = await this.prisma.store.findUnique({
      where: { id: created.storeId },
      select: { metricsVisibility: true },
    });
    return toPublic(created, store?.metricsVisibility);
  }

  // Public list, filtered by store. Returns only available + in-stock
  // products by default so the storefront never accidentally surfaces an
  // unsellable item; pass `includeUnavailable=true` (used by the dashboard)
  // to bypass that filter.
  //
  // Store-status gate (QA audit follow-up): products from non-public
  // stores (draft / submitted / pending_review / changes_requested /
  // rejected / suspended) never appear here. The dashboard reaches
  // its own pre-approval products via the merchant-private
  // `/store/*` endpoints (StoreController) which use a different
  // service path with owner-asserts. PUBLIC_STORE_STATUSES is the
  // shared allow-list — see stores.service.ts.
  //
  // Metrics projection: every row in the result shares the same
  // parent store, so we fetch `metricsVisibility` ONCE and reuse
  // it for the full list. No N+1, no per-product visibility
  // query. The empty-storeId guard short-circuits before any DB
  // work, matching the legacy behavior.
  async list(
    storeId: string,
    opts: { includeUnavailable?: boolean } = {},
  ): Promise<PublicProduct[]> {
    if (!storeId) return [];
    // Reject the storeId up front when the parent store isn't in a
    // public status. Two queries collapse into a transaction: one
    // looks up store status + metricsVisibility, the other lists
    // products (only if the store passed). A short-circuit on the
    // status check saves the product query entirely for hidden
    // stores.
    const store = await this.prisma.store.findFirst({
      where: {
        id: storeId,
        status: { in: PUBLIC_STORE_STATUSES as unknown as string[] },
      },
      select: { metricsVisibility: true },
    });
    if (!store) return [];

    const products = await this.prisma.product.findMany({
      where: {
        storeId,
        ...(opts.includeUnavailable
          ? {}
          : { isAvailable: true, stockStatus: 'in_stock' }),
      },
      select: PUBLIC_PRODUCT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    const visibility = store.metricsVisibility;
    const now = new Date();
    return products.map((p) => toPublic(p, visibility, now));
  }

  async findOne(id: string): Promise<PublicProduct> {
    // findFirst (not findUnique) so we can attach the store-status
    // filter. A product whose parent store is in a non-public state
    // 404s — indistinguishable from "product doesn't exist" — so
    // direct deep-links to suspended-store catalog can't leak.
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        store: {
          status: { in: PUBLIC_STORE_STATUSES as unknown as string[] },
        },
      },
      // Pull in the parent store's visibility flags inline so we
      // can project in one round-trip — no second query for the
      // single-product path.
      select: {
        ...PUBLIC_PRODUCT_SELECT,
        store: { select: { metricsVisibility: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    const { store, ...row } = product;
    return toPublic(row, store?.metricsVisibility);
  }

  async update(viewerUserId: string, id: string, body: UpdateProductInput) {
    const existing = await this.prisma.product.findUnique({
      where: { id },
      select: { id: true, storeId: true },
    });
    if (!existing) throw new NotFoundException('Product not found');
    await this.stores.assertOwner(viewerUserId, existing.storeId);

    // Phase 2.5a — validate + normalise the gallery + video
    // inputs up front, BEFORE any DB write, so a malformed input
    // never partially mutates the row.
    const imageUrls = normaliseImageUrls(body.imageUrls);
    const video = normaliseVideo(body.videoUrl, body.videoType);

    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.category === 'string') data.category = body.category.trim();
    // Gallery sync — when body.imageUrls is provided, the
    // imageUrls[0] becomes the new denormalised imageUrl. Empty
    // array clears both. When imageUrls is undefined (not touched
    // by the caller), legacy body.imageUrl still applies via its
    // own branch below.
    if (imageUrls !== null) {
      data.imageUrl = imageUrls.length > 0 ? imageUrls[0] : null;
    } else if (typeof body.imageUrl === 'string') {
      data.imageUrl = body.imageUrl.trim() || null;
    } else if (typeof body.imageUrl === 'object' && body.imageUrl === null) {
      data.imageUrl = null;
    }
    if (video !== null) {
      data.videoUrl = video.videoUrl;
      data.videoType = video.videoType;
    }
    if (body.price !== undefined) {
      const price = parsePrice(body.price);
      if (price == null) {
        throw new BadRequestException('price must be a non-negative number');
      }
      data.price = price;
    }
    if (typeof body.isFastDelivery === 'boolean')
      data.isFastDelivery = body.isFastDelivery;
    if (body.stockStatus === 'in_stock' || body.stockStatus === 'out_of_stock')
      data.stockStatus = body.stockStatus;
    if (typeof body.isAvailable === 'boolean')
      data.isAvailable = body.isAvailable;

    // Gallery replace + Product update are in one transaction so
    // a partial failure (e.g. ProductImage rows replaced but the
    // Product update fails) can't leave the row inconsistent.
    // The deleteMany→createMany pattern is the canonical "replace
    // an ordered set" idiom for Prisma — cleaner than diffing the
    // existing rows against the incoming list, and the
    // @@unique(productId, displayOrder) constraint guarantees the
    // ordinals are unambiguous after the transaction.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (imageUrls !== null) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        if (imageUrls.length > 0) {
          await tx.productImage.createMany({
            data: imageUrls.map((url, idx) => ({
              productId: id,
              url,
              displayOrder: idx,
            })),
          });
        }
      }
      return tx.product.update({
        where: { id },
        data,
        select: PUBLIC_PRODUCT_SELECT,
      });
    });
    // Merchant-driven update — they own the visibility dict
    // already. Read it once and apply the projection so the wire
    // shape matches every other path.
    const store = await this.prisma.store.findUnique({
      where: { id: updated.storeId },
      select: { metricsVisibility: true },
    });
    return toPublic(updated, store?.metricsVisibility);
  }

  async remove(viewerUserId: string, id: string) {
    const existing = await this.prisma.product.findUnique({
      where: { id },
      select: { id: true, storeId: true },
    });
    if (!existing) throw new NotFoundException('Product not found');
    await this.stores.assertOwner(viewerUserId, existing.storeId);
    await this.prisma.product.delete({ where: { id } });
    return { ok: true };
  }

  // Stock check used by Orders + Gifts before they create a row. Returns
  // null when the productId is unknown (legacy/sample-product flows that
  // don't pass an id) — callers treat null as "no constraint to check".
  //
  // Store-status gate (QA audit follow-up): the buyer flow refuses to
  // accept a product whose parent store is no longer public. Without
  // this, a buyer could complete an order against a `suspended` /
  // `rejected` store (the public list filters them out, but a
  // bookmarked product URL or a stale wishlist entry would still
  // resolve and pay). Returns the same "not available" message so
  // we don't leak the moderation reason to the buyer.
  async checkAvailability(productId: string | null | undefined) {
    if (!productId) return null;
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        storeId: true,
        isAvailable: true,
        stockStatus: true,
        store: { select: { status: true } },
      },
    });
    if (!product) {
      throw new BadRequestException('المنتج غير موجود');
    }
    if (!product.isAvailable || product.stockStatus !== 'in_stock') {
      throw new BadRequestException('المنتج غير متوفر حاليًا');
    }
    const storeStatus = product.store?.status ?? null;
    if (
      !storeStatus ||
      !(PUBLIC_STORE_STATUSES as readonly string[]).includes(storeStatus)
    ) {
      throw new BadRequestException('المنتج غير متوفر حاليًا');
    }
    // Strip the join before returning so the wire shape stays the
    // same (callers select `id, storeId, isAvailable, stockStatus`).
    const { store: _ignored, ...row } = product;
    void _ignored;
    return row;
  }
}

// Parse a price out of either a number or a numeric string. Refuses
// negatives and NaN. Used by both create and update.
function parsePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
