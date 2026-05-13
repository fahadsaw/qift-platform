import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from '../stores/stores.service';
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
  images: {
    select: { url: true, displayOrder: true },
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
  category: string;
  isFastDelivery: boolean;
  sourceType: string;
  externalProductId: string | null;
  stockStatus: string;
  isAvailable: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  images: { url: string; displayOrder: number }[];
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
  imageUrl?: string | null;
  category?: string;
  isFastDelivery?: boolean;
  stockStatus?: 'in_stock' | 'out_of_stock';
};

export type UpdateProductInput = Partial<CreateProductInput> & {
  isAvailable?: boolean;
};

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

    const created = await this.prisma.product.create({
      data: {
        storeId,
        name,
        price,
        category,
        imageUrl: body.imageUrl?.trim() || null,
        isFastDelivery: body.isFastDelivery === true,
        sourceType: 'manual',
        stockStatus:
          body.stockStatus === 'out_of_stock' ? 'out_of_stock' : 'in_stock',
        isAvailable: true,
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
    const [store, products] = await this.prisma.$transaction([
      this.prisma.store.findUnique({
        where: { id: storeId },
        select: { metricsVisibility: true },
      }),
      this.prisma.product.findMany({
        where: {
          storeId,
          ...(opts.includeUnavailable
            ? {}
            : { isAvailable: true, stockStatus: 'in_stock' }),
        },
        select: PUBLIC_PRODUCT_SELECT,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const visibility = store?.metricsVisibility;
    const now = new Date();
    return products.map((p) => toPublic(p, visibility, now));
  }

  async findOne(id: string): Promise<PublicProduct> {
    const product = await this.prisma.product.findUnique({
      where: { id },
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

    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.category === 'string') data.category = body.category.trim();
    if (typeof body.imageUrl === 'string')
      data.imageUrl = body.imageUrl.trim() || null;
    if (typeof body.imageUrl === 'object' && body.imageUrl === null)
      data.imageUrl = null;
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

    const updated = await this.prisma.product.update({
      where: { id },
      data,
      select: PUBLIC_PRODUCT_SELECT,
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
  async checkAvailability(productId: string | null | undefined) {
    if (!productId) return null;
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        storeId: true,
        isAvailable: true,
        stockStatus: true,
      },
    });
    if (!product) {
      throw new BadRequestException('المنتج غير موجود');
    }
    if (!product.isAvailable || product.stockStatus !== 'in_stock') {
      throw new BadRequestException('المنتج غير متوفر حاليًا');
    }
    return product;
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
