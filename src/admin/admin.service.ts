import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Admin-only service. Every method is reachable through routes
// guarded by AdminGuard, so we can assume the caller has already
// been authenticated + role-checked. We still take a `viewerUserId`
// on every method so:
//   - we can prevent self-demotion (admin cannot strip their own
//     role; another admin must do it).
//   - audit logs (when added) can attribute the change.
//
// We also keep responses minimal — admin views deliberately omit
// fields not needed for the operation (passwordHash never appears,
// gift messageText / mediaUrl are excluded, address is shown but
// never sent over the wire to anyone outside the admin route).

const ALLOWED_ROLES = new Set(['user', 'store', 'admin']);
const ALLOWED_STORE_STATUSES = new Set([
  'pending',
  'approved',
  'rejected',
  'suspended',
]);
const ALLOWED_REPORT_STATUSES = new Set([
  'open',
  'reviewed',
  'dismissed',
  'actioned',
]);

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // --- Users -------------------------------------------------------

  // List users with optional substring search across qiftUsername /
  // fullName / phone / email. We deliberately page with a fixed take
  // (50) — admin browsing only ever needs the recent / matched
  // window, not the full table. Soft-deleted users are filtered out
  // by default; an explicit `includeDeleted=1` query param could be
  // added later if support needs it.
  async listUsers(q: string | undefined): Promise<AdminUserRow[]> {
    const term = (q ?? '').trim();
    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(term.length === 0
          ? {}
          : {
              OR: [
                { qiftUsername: { contains: term, mode: 'insensitive' } },
                { fullName: { contains: term, mode: 'insensitive' } },
                { phone: { contains: term } },
                { email: { contains: term, mode: 'insensitive' } },
              ],
            }),
      },
      select: ADMIN_USER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows;
  }

  // Promote / demote. Refuses self-demotion: an admin cannot remove
  // their own role — another admin must do it. This keeps the system
  // from accidentally locking itself out.
  async setUserRole(
    viewerUserId: string,
    targetUserId: string,
    role: string,
  ): Promise<AdminUserRow> {
    if (!ALLOWED_ROLES.has(role)) {
      throw new BadRequestException('Invalid role');
    }
    if (viewerUserId === targetUserId && role !== 'admin') {
      throw new ForbiddenException(
        'Admins cannot demote themselves; ask another admin.',
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      throw new NotFoundException('User not found');
    }
    return this.prisma.user.update({
      where: { id: targetUserId },
      data: { role },
      select: ADMIN_USER_SELECT,
    });
  }

  // --- Stores ------------------------------------------------------

  async listStores(q: string | undefined): Promise<AdminStoreRow[]> {
    const term = (q ?? '').trim();
    return this.prisma.store.findMany({
      where:
        term.length === 0
          ? {}
          : {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { city: { contains: term, mode: 'insensitive' } },
              ],
            },
      select: ADMIN_STORE_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async setStoreStatus(
    storeId: string,
    status: string,
  ): Promise<AdminStoreRow> {
    if (!ALLOWED_STORE_STATUSES.has(status)) {
      throw new BadRequestException('Invalid store status');
    }
    const existing = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Store not found');
    return this.prisma.store.update({
      where: { id: storeId },
      data: { status },
      select: ADMIN_STORE_SELECT,
    });
  }

  // --- Gifts -------------------------------------------------------

  // Recent gifts list for ops monitoring. Unlike the user-facing
  // /gifts endpoints, admin sees BOTH parties' usernames. We still
  // omit messageText / mediaUrl / mediaType (buyer-private content
  // — admin doesn't need the gift contents to debug fulfilment) and
  // never serialize the linked address row over this surface (admin
  // can drill into the store dashboard if address is genuinely
  // needed for support).
  async listGifts(): Promise<AdminGiftRow[]> {
    const rows = await this.prisma.gift.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        productName: true,
        storeName: true,
        status: true,
        isAnonymous: true,
        createdAt: true,
        sender: { select: { id: true, qiftUsername: true } },
        receiver: { select: { id: true, qiftUsername: true } },
      },
    });
    return rows.map((g) => ({
      id: g.id,
      productName: g.productName,
      storeName: g.storeName,
      status: g.status,
      isAnonymous: g.isAnonymous,
      createdAt: g.createdAt,
      sender: g.sender,
      receiver: g.receiver,
    }));
  }

  // --- Reports -----------------------------------------------------

  async listReports(): Promise<AdminReportRow[]> {
    const rows = await this.prisma.report.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      select: {
        id: true,
        reason: true,
        details: true,
        status: true,
        createdAt: true,
        reporterId: true,
        reportedUserId: true,
        reporter: { select: { id: true, qiftUsername: true } },
      },
    });
    // The Report schema has reportedUserId as a plain column (no
    // relation in the schema today). We resolve the username with a
    // single batched query for ergonomics in the admin UI.
    const reportedIds = Array.from(new Set(rows.map((r) => r.reportedUserId)));
    const reportedUsers = reportedIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: reportedIds } },
          select: { id: true, qiftUsername: true },
        })
      : [];
    const usernameById = new Map(
      reportedUsers.map((u) => [u.id, u.qiftUsername]),
    );
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt,
      reporter: r.reporter,
      reportedUser: {
        id: r.reportedUserId,
        qiftUsername: usernameById.get(r.reportedUserId) ?? null,
      },
    }));
  }

  async setReportStatus(
    reportId: string,
    status: string,
  ): Promise<{ id: string; status: string }> {
    if (!ALLOWED_REPORT_STATUSES.has(status)) {
      throw new BadRequestException('Invalid report status');
    }
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Report not found');
    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: { status },
      select: { id: true, status: true },
    });
    return updated;
  }

  // --- System ------------------------------------------------------

  // Lightweight ops dashboard: totals + which optional integrations
  // are configured. No secrets are echoed back — only positive flags
  // saying "this env is wired" so operators can spot a misconfigured
  // staging deploy at a glance.
  async getSystemStatus(): Promise<AdminSystemStatus> {
    const [
      userCount,
      storeCount,
      pendingStoreCount,
      giftCount,
      openReportCount,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.store.count(),
      this.prisma.store.count({ where: { status: 'pending' } }),
      this.prisma.gift.count(),
      this.prisma.report.count({ where: { status: 'open' } }),
    ]);
    return {
      counts: {
        users: userCount,
        stores: storeCount,
        pendingStores: pendingStoreCount,
        gifts: giftCount,
        openReports: openReportCount,
      },
      integrations: {
        // Cloudflare R2 (avatar + post media).
        r2: Boolean(
          process.env.R2_BUCKET &&
          process.env.R2_ACCESS_KEY_ID &&
          process.env.R2_PUBLIC_BASE_URL,
        ),
        // Push notifications (VAPID keys).
        push: Boolean(
          process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
        ),
        // SMS OTP (Taqnyat).
        sms: Boolean(process.env.TAQNYAT_BEARER_TOKEN),
        // Future merchant API surface — placeholder for now.
        merchantApi: false,
      },
    };
  }

  // --- Diagnostics -------------------------------------------------
  //
  // Lineage inspector for the "merchant doesn't see this order"
  // class of bugs. Surfaces every link in the chain so the operator
  // can read off exactly where it broke without writing SQL:
  //
  //   Order → Gift → Product → Store → owner
  //
  // The verdict block at the end runs the same WHERE clause that
  // /store/orders uses and answers "would the merchant see this?"
  // with a structured reason code so the next "I can't see it"
  // report is a one-call diagnosis.
  //
  // Privacy: identifiers + status fields only. NO recipient
  // address, NO message text, NO media. The route is admin-gated
  // but the response shape is conservative anyway — a leaked
  // diagnostic should not contain content the receiver hasn't
  // seen yet.

  async diagnoseLatestGift(): Promise<GiftDiagnosis> {
    const latest = await this.prisma.gift.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!latest) {
      throw new NotFoundException('No gifts exist yet');
    }
    return this.diagnoseGift(latest.id);
  }

  async diagnoseGift(giftId: string): Promise<GiftDiagnosis> {
    const gift = await this.prisma.gift.findUnique({
      where: { id: giftId },
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        productName: true,
        storeName: true,
        storeId: true,
        productId: true,
        addressId: true,
        status: true,
        isAnonymous: true,
        isSurprise: true,
        createdAt: true,
        confirmedAt: true,
        shippedAt: true,
        deliveredAt: true,
      },
    });
    if (!gift) throw new NotFoundException('Gift not found');

    // Look up the matching Order (1:1 via Order.giftId). When the
    // gift was created via the payment flow there's always one;
    // direct POST /gifts paths (admin tooling) leave it null.
    const order = await this.prisma.order.findFirst({
      where: { giftId: gift.id },
      select: {
        id: true,
        userId: true,
        productId: true,
        storeId: true,
        productName: true,
        storeName: true,
        status: true,
        createdAt: true,
      },
    });

    // Resolve the catalog product (if any). Authoritative source
    // for "what storeId SHOULD this be linked to?".
    const product = gift.productId
      ? await this.prisma.product.findUnique({
          where: { id: gift.productId },
          select: {
            id: true,
            storeId: true,
            name: true,
            isAvailable: true,
            stockStatus: true,
          },
        })
      : null;

    // Resolve the store via the gift's stored storeId (preferred)
    // OR via the product (fallback) — both because the bug class
    // is "gift.storeId got dropped, but product knows the right
    // store". Surfacing both lets the operator spot the drift.
    const giftStore = gift.storeId
      ? await this.prisma.store.findUnique({
          where: { id: gift.storeId },
          select: {
            id: true,
            name: true,
            ownerId: true,
            status: true,
            owner: { select: { id: true, qiftUsername: true } },
          },
        })
      : null;
    const productStore =
      product?.storeId && product.storeId !== gift.storeId
        ? await this.prisma.store.findUnique({
            where: { id: product.storeId },
            select: {
              id: true,
              name: true,
              ownerId: true,
              status: true,
              owner: { select: { id: true, qiftUsername: true } },
            },
          })
        : null;

    // Compute the /store/orders verdict. Mirrors
    // StoreService.listOrders WHERE clause exactly so the
    // diagnostic answer matches what the merchant will see at
    // request time.
    const DASHBOARD_STATUSES = [
      'pending_address',
      'address_confirmed',
      'default_address_used',
      'preparing',
      'shipped',
    ];
    const merchant = giftStore?.owner ?? productStore?.owner ?? null;
    let verdict: GiftDiagnosisVerdict;
    if (!gift.storeId) {
      verdict = {
        wouldShowOnMerchantDashboard: false,
        reason: 'gift_storeId_null',
        explain:
          'Gift.storeId is null. /store/orders filters by storeId IN (mystoreids); the row will never appear. Run scripts/backfill-gift-storeid.ts (with --apply) if Product.storeId is known.',
      };
    } else if (!giftStore) {
      verdict = {
        wouldShowOnMerchantDashboard: false,
        reason: 'gift_store_not_found',
        explain:
          'Gift.storeId is set but no Store row exists for it. Likely a hard-deleted store (onDelete: SetNull missed) or a typo from a tampered payload.',
      };
    } else if (!DASHBOARD_STATUSES.includes(gift.status)) {
      verdict = {
        wouldShowOnMerchantDashboard: false,
        reason: 'status_excluded',
        explain: `Gift.status="${gift.status}" is not in DASHBOARD_STATUSES (${DASHBOARD_STATUSES.join(', ')}). Either delivered (terminal) or cancelled.`,
      };
    } else {
      verdict = {
        wouldShowOnMerchantDashboard: true,
        reason: 'ok',
        explain: `Owner ${giftStore.owner?.qiftUsername ?? giftStore.ownerId} sees this row when logged in. Status=${gift.status}, store=${giftStore.name}.`,
      };
    }

    return {
      gift: {
        id: gift.id,
        productId: gift.productId,
        storeId: gift.storeId,
        productName: gift.productName,
        storeName: gift.storeName,
        status: gift.status,
        isAnonymous: gift.isAnonymous,
        isSurprise: gift.isSurprise,
        addressId: gift.addressId,
        createdAt: gift.createdAt,
        confirmedAt: gift.confirmedAt,
        shippedAt: gift.shippedAt,
        deliveredAt: gift.deliveredAt,
      },
      order: order
        ? {
            id: order.id,
            buyerId: order.userId,
            productId: order.productId,
            storeId: order.storeId,
            status: order.status,
            createdAt: order.createdAt,
            // Drift = "buyer's checkout payload sent X but the
            // gift ended up with Y". Common when an old client
            // hits a new server, or vice versa.
            storeIdMatchesGift: order.storeId === gift.storeId,
            productIdMatchesGift: order.productId === gift.productId,
          }
        : null,
      product: product
        ? {
            id: product.id,
            storeId: product.storeId,
            name: product.name,
            isAvailable: product.isAvailable,
            stockStatus: product.stockStatus,
          }
        : null,
      giftStore: giftStore
        ? {
            id: giftStore.id,
            name: giftStore.name,
            ownerId: giftStore.ownerId,
            ownerUsername: giftStore.owner?.qiftUsername ?? null,
            status: giftStore.status,
          }
        : null,
      // Renders only when productStore differs from giftStore —
      // i.e. someone moved the product between stores OR the
      // gift's storeId was drifted away from the product's
      // canonical owner. Either way the operator sees both.
      productStore: productStore
        ? {
            id: productStore.id,
            name: productStore.name,
            ownerId: productStore.ownerId,
            ownerUsername: productStore.owner?.qiftUsername ?? null,
            status: productStore.status,
          }
        : null,
      merchant: merchant
        ? { userId: merchant.id, qiftUsername: merchant.qiftUsername }
        : null,
      verdict,
    };
  }
}

// --- Projections ---------------------------------------------------

const ADMIN_USER_SELECT = {
  id: true,
  qiftUsername: true,
  fullName: true,
  phone: true,
  email: true,
  role: true,
  createdAt: true,
  phoneVerifiedAt: true,
  emailVerifiedAt: true,
} as const;

const ADMIN_STORE_SELECT = {
  id: true,
  name: true,
  city: true,
  category: true,
  status: true,
  integrationStatus: true,
  integrationType: true,
  createdAt: true,
  ownerId: true,
  owner: { select: { id: true, qiftUsername: true } },
} as const;

// --- Public response shapes ---------------------------------------

export type AdminUserRow = {
  id: string;
  qiftUsername: string;
  fullName: string | null;
  phone: string;
  email: string | null;
  role: string;
  createdAt: Date;
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
};

export type AdminStoreRow = {
  id: string;
  name: string;
  city: string;
  category: string;
  status: string;
  integrationStatus: string;
  integrationType: string;
  createdAt: Date;
  ownerId: string;
  owner: { id: string; qiftUsername: string } | null;
};

export type AdminGiftRow = {
  id: string;
  productName: string;
  storeName: string;
  status: string;
  isAnonymous: boolean;
  createdAt: Date;
  sender: { id: string; qiftUsername: string } | null;
  receiver: { id: string; qiftUsername: string } | null;
};

export type AdminReportRow = {
  id: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: Date;
  reporter: { id: string; qiftUsername: string } | null;
  reportedUser: { id: string; qiftUsername: string | null };
};

export type AdminSystemStatus = {
  counts: {
    users: number;
    stores: number;
    pendingStores: number;
    gifts: number;
    openReports: number;
  };
  integrations: {
    r2: boolean;
    push: boolean;
    sms: boolean;
    merchantApi: boolean;
  };
};

// Gift lineage diagnostic. Surfaces every link in the chain that
// determines whether a merchant sees an order on /store/orders,
// plus a structured verdict so the operator gets a one-call answer
// to "why doesn't merchant X see this gift?".
export type GiftDiagnosisVerdict = {
  wouldShowOnMerchantDashboard: boolean;
  // Stable code so the frontend / ops scripts can branch without
  // string-matching the explain text.
  reason:
    | 'ok'
    | 'gift_storeId_null'
    | 'gift_store_not_found'
    | 'status_excluded';
  explain: string;
};

export type GiftDiagnosis = {
  gift: {
    id: string;
    productId: string | null;
    storeId: string | null;
    productName: string;
    storeName: string;
    status: string;
    isAnonymous: boolean;
    isSurprise: boolean;
    addressId: string | null;
    createdAt: Date;
    confirmedAt: Date | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
  };
  order: {
    id: string;
    buyerId: string;
    productId: string | null;
    storeId: string | null;
    status: string;
    createdAt: Date;
    storeIdMatchesGift: boolean;
    productIdMatchesGift: boolean;
  } | null;
  product: {
    id: string;
    storeId: string;
    name: string;
    isAvailable: boolean;
    stockStatus: string;
  } | null;
  giftStore: {
    id: string;
    name: string;
    ownerId: string;
    ownerUsername: string | null;
    status: string;
  } | null;
  productStore: {
    id: string;
    name: string;
    ownerId: string;
    ownerUsername: string | null;
    status: string;
  } | null;
  merchant: { userId: string; qiftUsername: string } | null;
  verdict: GiftDiagnosisVerdict;
};
