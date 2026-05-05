import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from '../stores/stores.service';

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
} as const;

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

    return this.prisma.product.create({
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
  }

  // Public list, filtered by store. Returns only available + in-stock
  // products by default so the storefront never accidentally surfaces an
  // unsellable item; pass `includeUnavailable=true` (used by the dashboard)
  // to bypass that filter.
  list(storeId: string, opts: { includeUnavailable?: boolean } = {}) {
    if (!storeId) return [];
    return this.prisma.product.findMany({
      where: {
        storeId,
        ...(opts.includeUnavailable
          ? {}
          : { isAvailable: true, stockStatus: 'in_stock' }),
      },
      select: PUBLIC_PRODUCT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: PUBLIC_PRODUCT_SELECT,
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
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

    return this.prisma.product.update({
      where: { id },
      data,
      select: PUBLIC_PRODUCT_SELECT,
    });
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
