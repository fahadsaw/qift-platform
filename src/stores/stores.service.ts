import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const FORBIDDEN_MSG = 'غير مصرح لك';

// Public-facing fields. Notably excludes `webhookSecret` so the secret
// never leaks via list/detail endpoints — it's only ever returned from
// the explicit /store-integrations/connect call to the owner.
const PUBLIC_STORE_SELECT = {
  id: true,
  name: true,
  city: true,
  category: true,
  integrationType: true,
  integrationStatus: true,
  ownerId: true,
  createdAt: true,
} as const;

export type CreateStoreInput = {
  name?: string;
  city?: string;
  category?: string;
};

export type UpdateStoreInput = {
  name?: string;
  city?: string;
  category?: string;
};

@Injectable()
export class StoresService {
  constructor(private prisma: PrismaService) {}

  // Owner = JWT viewer. Name + city + category are required because
  // every downstream surface (dashboard header, search, stock checks)
  // assumes those fields are non-empty.
  //
  // Side effect: the User's role is bumped to "store" so the UI can
  // surface the dashboard link without a separate ownership lookup. We
  // never demote the role on store deletion (a user can be reinstated
  // later), but we also never depend on it for authz — every mutation
  // re-checks ownership in the service layer.
  async create(viewerUserId: string, body: CreateStoreInput) {
    const name = body.name?.trim();
    const city = body.city?.trim();
    const category = body.category?.trim();
    if (!name || !city || !category) {
      throw new BadRequestException('name, city and category are required');
    }

    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: {
          name,
          city,
          category,
          ownerId: viewerUserId,
        },
        select: PUBLIC_STORE_SELECT,
      });
      // Bump the user's role so the UI can render the right nav links.
      await tx.user.update({
        where: { id: viewerUserId },
        data: { role: 'store' },
      });
      return store;
    });
  }

  // Public listing — anyone (even unauthenticated UI) can browse stores.
  // We never include `webhookSecret`.
  list() {
    return this.prisma.store.findMany({
      select: PUBLIC_STORE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Stores owned by the JWT viewer. Powers the store dashboard's "pick
  // your store" header and the create-store CTA visibility.
  listMine(viewerUserId: string) {
    return this.prisma.store.findMany({
      where: { ownerId: viewerUserId },
      select: PUBLIC_STORE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const store = await this.prisma.store.findUnique({
      where: { id },
      select: PUBLIC_STORE_SELECT,
    });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async update(viewerUserId: string, id: string, body: UpdateStoreInput) {
    await this.assertOwner(viewerUserId, id);
    const data: UpdateStoreInput = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.city === 'string') data.city = body.city.trim();
    if (typeof body.category === 'string') data.category = body.category.trim();
    return this.prisma.store.update({
      where: { id },
      data,
      select: PUBLIC_STORE_SELECT,
    });
  }

  // Returns the store if the viewer owns it; otherwise throws 403. Other
  // services (Products, Store dashboard, integrations) call this before
  // any mutation — there's no other path to ownership in the codebase
  // so the rule is in one place.
  async assertOwner(viewerUserId: string, storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ownerId: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.ownerId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return store;
  }

  // Returns the list of store ids the viewer owns. Used by the store
  // dashboard to scope its order query.
  async ownedStoreIds(viewerUserId: string): Promise<string[]> {
    const rows = await this.prisma.store.findMany({
      where: { ownerId: viewerUserId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
