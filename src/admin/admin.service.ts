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
