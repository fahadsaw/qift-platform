import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from '../stores/stores.service';

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
  constructor(
    private prisma: PrismaService,
    // Reused for the v2 review endpoints (approve/reject/request_changes
    // + the rich owner detail projection). Single source of truth for
    // the merchant-application transition graph.
    private stores: StoresService,
  ) {}

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

  // Onboarding-v2 review with operator note. Delegates to
  // StoresService.review which:
  //   - validates action ∈ { approve, reject, request_changes }
  //   - enforces non-empty reason for reject / request_changes
  //   - timestamps reviewedAt and stores reviewedBy = adminUserId
  //   - sets the right status string + rejectionReason
  async reviewStore(
    adminUserId: string,
    storeId: string,
    action: 'approve' | 'reject' | 'request_changes',
    reason: string | null,
  ) {
    if (
      action !== 'approve' &&
      action !== 'reject' &&
      action !== 'request_changes'
    ) {
      throw new BadRequestException('Invalid review action');
    }
    return this.stores.review(adminUserId, storeId, action, reason);
  }

  // Owner-or-admin detail projection. Routes through the same
  // StoresService method the merchant uses on their pending-
  // approval screen — single source of truth for the rich
  // shape (zones, rejectionReason, business fields).
  async storeDetail(viewerUserId: string, storeId: string) {
    return this.stores.findOneForOwnerOrAdmin(viewerUserId, storeId);
  }

  // Admin-only plan assignment. Wraps StoresService.setPlan so the
  // admin module owns the route surface; the underlying validation
  // (plan in the allowed set, store exists) lives in StoresService.
  async setStorePlan(storeId: string, plan: string) {
    return this.stores.setPlan(storeId, plan);
  }

  // Marketplace featured toggle. Idempotent — re-applying the
  // same value is a no-op write at the DB level (Prisma update
  // is safe on equal data).
  async setStoreFeatured(storeId: string, featured: boolean) {
    return this.stores.setFeatured(storeId, featured);
  }

  // Verification documents uploaded with the merchant application.
  // Returns the StoreDocument rows for the admin review modal.
  async listStoreDocuments(storeId: string) {
    return this.prisma.storeDocument.findMany({
      where: { storeId },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        type: true,
        fileUrl: true,
        fileName: true,
        contentType: true,
        uploadedAt: true,
      },
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

  // Browser-friendly merchant-order debug. Returns the latest Order
  // alongside the latest Gift's full lineage so the operator can
  // see both at once without two requests. Optional ?merchant
  // username adds an explicit ownership check.
  //
  // The verdict block is the same as diagnoseGift, with a single
  // additional code (`merchant_does_not_own_store`) when the
  // ?merchant flag is present and the user doesn't own the store
  // the gift links to.
  //
  // NEVER includes: messageText, mediaUrl, mediaType, address
  // fields, sender PII beyond username. Safe to paste in a public
  // support thread.
  async debugLatestMerchantOrder(merchantUsername?: string): Promise<{
    latestOrder: AdminLatestOrderRow | null;
    latestGift: GiftDiagnosis | null;
    merchantCheck: AdminMerchantCheck | null;
  }> {
    const latestOrder = await this.prisma.order.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        productId: true,
        storeId: true,
        productName: true,
        storeName: true,
        status: true,
        currency: true,
        totalAmount: true,
        paymentProvider: true,
        giftId: true,
        createdAt: true,
      },
    });

    const latestGiftRow = await this.prisma.gift.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const latestGift = latestGiftRow
      ? await this.diagnoseGift(latestGiftRow.id)
      : null;

    let merchantCheck: AdminMerchantCheck | null = null;
    const username = merchantUsername?.trim().toLowerCase() ?? '';
    if (username.length > 0) {
      const merchant = await this.prisma.user.findFirst({
        where: { qiftUsername: username, deletedAt: null },
        select: { id: true, qiftUsername: true, role: true },
      });
      if (!merchant) {
        merchantCheck = {
          username,
          found: false,
          role: null,
          hasStoreRole: false,
          ownedStoreCount: 0,
          ownsLatestGiftStore: false,
          // Even if the user doesn't exist, telling the operator
          // "no such user" is a useful diagnostic — wrong-username
          // typo is a common false-positive in support reports.
          note: 'no user with this qiftUsername (case-insensitive)',
        };
      } else {
        const owned = await this.prisma.store.findMany({
          where: { ownerId: merchant.id },
          select: { id: true, name: true, status: true },
        });
        const ownsLatestGiftStore = latestGift?.gift.storeId
          ? owned.some((s) => s.id === latestGift.gift.storeId)
          : false;
        // Surface the exact reason the merchant might be locked
        // out of /store/orders so the operator doesn't have to
        // check three places. Three failure modes covered:
        //   - user.role !== 'store' (StoreGuard rejects with 403
        //     unless STORE_USER_IDS env override is set)
        //   - owns no stores at all (StoreGuard rejects)
        //   - owns stores but not THIS gift's store
        let note: string;
        if (merchant.role !== 'store' && merchant.role !== 'admin') {
          note = `user.role="${merchant.role}" — StoreGuard will reject /store/orders unless STORE_USER_IDS env override includes this id.`;
        } else if (owned.length === 0) {
          note = `user has no Store rows — StoreGuard will reject /store/orders.`;
        } else if (!ownsLatestGiftStore && latestGift?.gift.storeId) {
          note = `user owns ${owned.length} store(s) but NONE of them match the latest gift's storeId. Wrong account logged in?`;
        } else if (!latestGift?.gift.storeId) {
          note = `latest gift has storeId=null — owning the right store does not help; the gift itself isn't linked to any merchant.`;
        } else {
          note = `user owns the store this gift is linked to. /store/orders SHOULD return it.`;
        }
        merchantCheck = {
          username: merchant.qiftUsername,
          found: true,
          role: merchant.role,
          hasStoreRole: merchant.role === 'store' || merchant.role === 'admin',
          ownedStoreCount: owned.length,
          ownsLatestGiftStore,
          ownedStores: owned.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
          })),
          note,
        };
      }
    }

    return {
      latestOrder,
      latestGift,
      merchantCheck,
    };
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

  // ── Seed verification ────────────────────────────────────────
  //
  // Tells the operator what state the production DB is in, after
  // a merchant-onboarding-v2 deploy. Three checks:
  //
  //   1. Schema migration applied?  Probes for one of the new
  //      Store columns (deliveryZones). If absent, migrate didn't
  //      run.
  //   2. Test merchants exist?      Looks up the two seeded users
  //      by qiftUsername (case-insensitive).
  //   3. Stores + products linked?  Counts owned stores and
  //      products per merchant.
  //
  // PRIVACY: only usernames + counts in the response. No phones,
  // no emails, no password hashes. Safe to paste into a support
  // thread.
  async debugSeedStatus(): Promise<SeedStatus> {
    // Schema check via raw query against information_schema.
    // Faster than a probe-update and works even when the test
    // merchants don't exist yet.
    const rows = await this.prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'Store'
         AND column_name IN ('deliveryZones', 'legalEntityName',
                             'rejectionReason', 'submittedAt',
                             'reviewedAt', 'reviewedBy')`,
    );
    const presentColumns = new Set(rows.map((r) => r.column_name));
    const expectedColumns = [
      'deliveryZones',
      'legalEntityName',
      'rejectionReason',
      'submittedAt',
      'reviewedAt',
      'reviewedBy',
    ];
    const missingColumns = expectedColumns.filter(
      (c) => !presentColumns.has(c),
    );
    const migrationApplied = missingColumns.length === 0;

    // Per-merchant probe. We look up by qiftUsername (case-
    // insensitive) AND by deterministic id from the seed script.
    const merchants = await this._probeSeededMerchant([
      'merchant.riyadh.flowers',
      'merchant.gcc.perfumes',
    ]);

    return {
      migrationApplied,
      missingColumns,
      merchants,
    };
  }

  // Run-on-demand seed for the two onboarding-v2 test merchants.
  // Pulls the same fixtures used by prisma/seed.ts but inlined so
  // the deployed dist/ can do this without invoking ts-node.
  // Idempotent: every entity uses upsert with a stable id, so
  // re-runs never duplicate.
  //
  // Auth: this controller is wrapped in JwtAuthGuard + AdminGuard.
  // We additionally take the admin's userId for the audit log
  // line we emit at the end.
  async debugSeedMerchants(adminUserId: string): Promise<{
    seeded: string[];
    storeIds: string[];
    productCount: number;
  }> {
    // bcrypt is already a dep (used by AuthService); we import via
    // require so the seed code doesn't get tree-shaken into every
    // admin path. Cost is one require on first call.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bcrypt = require('bcryptjs') as typeof import('bcryptjs');
    const passwordHash = await bcrypt.hash('qift-merchant-dev', 10);

    const fixtures: SeedMerchantFixture[] = [
      {
        userId: 'merchant-riyadh-flowers',
        storeId: 'store-riyadh-flowers',
        username: 'merchant.riyadh.flowers',
        fullName: 'باقات الرياض',
        phone: '+966500000201',
        storeName: 'باقات الرياض',
        city: 'الرياض',
        category: 'flowers',
        legalEntityName: 'باقات الرياض للتجارة',
        countryOfRegistration: 'SA',
        commercialRegistrationNumber: '1010123456',
        contactPerson: 'مدير العمليات',
        contactPhone: '+966500000201',
        contactEmail: 'ops@riyadh-flowers.test',
        deliveryZones: [
          {
            city: 'الرياض',
            districts: [
              'العليا',
              'الملقا',
              'الياسمين',
              'النرجس',
              'الصحافة',
              'الفلاح',
              'حطين',
              'الورود',
              'الواحة',
            ],
          },
        ],
        products: [
          { slug: 'p1', name: 'باقة جوري الرياض', price: 250 },
          { slug: 'p2', name: 'باقة تيوليب فاخر', price: 380 },
          { slug: 'p3', name: 'صندوق ورد كلاسيكي', price: 290 },
          { slug: 'p4', name: 'باقة بيوني وردي', price: 340 },
          { slug: 'p5', name: 'تنسيق ورد للمكاتب', price: 420 },
        ],
      },
      {
        userId: 'merchant-gcc-perfumes',
        storeId: 'store-gcc-perfumes',
        username: 'merchant.gcc.perfumes',
        fullName: 'House of Oud',
        phone: '+966500000202',
        storeName: 'House of Oud',
        city: 'الرياض',
        category: 'perfume',
        legalEntityName: 'House of Oud Trading',
        countryOfRegistration: 'AE',
        commercialRegistrationNumber: 'DED-789456',
        contactPerson: 'Customer Care',
        contactPhone: '+971500000202',
        contactEmail: 'care@houseofoud.test',
        deliveryZones: [
          { city: 'الرياض' },
          { city: 'جدة' },
          { city: 'الدمام' },
          { city: 'الخبر' },
          { city: 'مكة المكرمة' },
          { city: 'المدينة المنورة' },
          { city: 'مدينة الكويت' },
          { city: 'السالمية' },
          { city: 'الفروانية' },
          { city: 'دبي' },
          { city: 'أبوظبي' },
          { city: 'الشارقة' },
          { city: 'الدوحة' },
          { city: 'المنامة' },
          { city: 'الرفاع' },
          { city: 'مسقط' },
          { city: 'صلالة' },
        ],
        products: [
          { slug: 'p1', name: 'عطر العود الملكي', price: 850 },
          { slug: 'p2', name: 'عطر زيت العود الفاخر', price: 1450 },
          { slug: 'p3', name: 'مجموعة العود الذهبية', price: 2200 },
          { slug: 'p4', name: 'بخور المسك الأبيض', price: 320 },
          { slug: 'p5', name: 'عطر الياسمين الدمشقي', price: 690 },
          { slug: 'p6', name: 'مجموعة هدية فاخرة', price: 3500 },
        ],
      },
    ];

    const seededUsernames: string[] = [];
    const storeIds: string[] = [];
    let productCount = 0;

    for (const f of fixtures) {
      // 1) Owner user. role='store' so the merchant nav surfaces
      // the dashboard link without a separate ownership lookup.
      // phoneVerifiedAt stamped so the login flow doesn't ask for
      // an OTP for these test accounts.
      await this.prisma.user.upsert({
        where: { id: f.userId },
        create: {
          id: f.userId,
          qiftUsername: f.username,
          fullName: f.fullName,
          phone: f.phone,
          passwordHash,
          role: 'store',
          phoneVerifiedAt: new Date(),
        },
        // Re-syncing the password hash + role on every call so an
        // operator who lost the password can rotate everyone in
        // one button-press.
        update: { passwordHash, role: 'store' },
      });

      // 2) Store row, status='approved' so it shows up in /stores
      // and /admin/stores immediately. v2 fields populated.
      // deliveryZones uses Prisma.DbNull when empty (matches
      // sanitizeZones contract).
      const v2Extras = {
        legalEntityName: f.legalEntityName,
        countryOfRegistration: f.countryOfRegistration,
        commercialRegistrationNumber: f.commercialRegistrationNumber,
        contactPerson: f.contactPerson,
        contactPhone: f.contactPhone,
        contactEmail: f.contactEmail.toLowerCase(),
        deliveryZones:
          f.deliveryZones.length > 0
            ? (f.deliveryZones as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
      };
      await this.prisma.store.upsert({
        where: { id: f.storeId },
        create: {
          id: f.storeId,
          name: f.storeName,
          ownerId: f.userId,
          city: f.city,
          category: f.category,
          status: 'approved',
          integrationType: 'none',
          integrationStatus: 'disconnected',
          ...v2Extras,
        },
        update: {
          name: f.storeName,
          city: f.city,
          category: f.category,
          ...v2Extras,
        },
      });

      // 3) Products. Stable ids so re-running never duplicates.
      for (const p of f.products) {
        await this.prisma.product.upsert({
          where: { id: `${f.storeId}-${p.slug}` },
          create: {
            id: `${f.storeId}-${p.slug}`,
            storeId: f.storeId,
            name: p.name,
            price: p.price,
            category: f.category,
            sourceType: 'manual',
            stockStatus: 'in_stock',
            isAvailable: true,
          },
          update: { name: p.name, price: p.price },
        });
        productCount += 1;
      }
      seededUsernames.push(f.username);
      storeIds.push(f.storeId);
    }

    // Ops audit line — admin who triggered the seed. Goes to the
    // Nest logger so Railway captures it without us writing a
    // dedicated audit table.

    console.log(
      `[seed-merchants] adminUserId=${adminUserId} seeded ${seededUsernames.length} merchants, ${productCount} products`,
    );

    return {
      seeded: seededUsernames,
      storeIds,
      productCount,
    };
  }

  private async _probeSeededMerchant(
    usernames: string[],
  ): Promise<MerchantSeedProbe[]> {
    const out: MerchantSeedProbe[] = [];
    for (const username of usernames) {
      const user = await this.prisma.user.findFirst({
        where: { qiftUsername: username, deletedAt: null },
        select: { id: true, qiftUsername: true, role: true, phone: true },
      });
      if (!user) {
        out.push({
          username,
          userExists: false,
          role: null,
          phoneMasked: null,
          ownedStoreCount: 0,
          productCount: 0,
          stores: [],
        });
        continue;
      }
      const stores = await this.prisma.store.findMany({
        where: { ownerId: user.id },
        select: { id: true, name: true, status: true },
      });
      const productCount = stores.length
        ? await this.prisma.product.count({
            where: { storeId: { in: stores.map((s) => s.id) } },
          })
        : 0;
      out.push({
        username: user.qiftUsername,
        userExists: true,
        role: user.role,
        // Mask phone: keep country code + last 4 digits for
        // identification without leaking the full number.
        phoneMasked: maskPhone(user.phone),
        ownedStoreCount: stores.length,
        productCount,
        stores: stores.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status ?? null,
        })),
      });
    }
    return out;
  }
}

// Mask all but the last 4 digits of a phone for diagnostic output.
function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.replace(/\s+/g, '');
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
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

export type AdminLatestOrderRow = {
  id: string;
  userId: string;
  productId: string | null;
  storeId: string | null;
  productName: string;
  storeName: string;
  status: string;
  currency: string;
  totalAmount: number;
  paymentProvider: string;
  giftId: string | null;
  createdAt: Date;
};

export type AdminMerchantCheck = {
  username: string;
  found: boolean;
  role: string | null;
  hasStoreRole: boolean;
  ownedStoreCount: number;
  ownsLatestGiftStore: boolean;
  ownedStores?: { id: string; name: string; status: string }[];
  note: string;
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

// Seed-status response shape. Used by the admin diagnostics panel
// to verify production state after a merchant-onboarding-v2
// deploy.
export type MerchantSeedProbe = {
  username: string;
  userExists: boolean;
  role: string | null;
  phoneMasked: string | null;
  ownedStoreCount: number;
  productCount: number;
  // Per-store detail so the admin diagnostics panel can render a
  // clickable storefront URL and visible status. `status` is null
  // for legacy rows that pre-date onboarding-v2 (the column was
  // backfilled to 'approved' but tolerate missing values).
  stores: { id: string; name: string; status: string | null }[];
};

export type SeedStatus = {
  // True when every expected v2 column exists on the Store
  // table. Goes false the moment one column is missing — usually
  // the signal that prisma migrate deploy didn't run.
  migrationApplied: boolean;
  // The columns we probed for that aren't present. Empty when
  // migrationApplied is true.
  missingColumns: string[];
  // Per-merchant existence + ownership probe.
  merchants: MerchantSeedProbe[];
};

// Inline seed fixture shape — matches the prisma/seed.ts contract
// so future divergence between the script and this endpoint is
// caught at the type level.
type SeedMerchantFixture = {
  userId: string;
  storeId: string;
  username: string;
  fullName: string;
  phone: string;
  storeName: string;
  city: string;
  category: string;
  legalEntityName: string;
  countryOfRegistration: string;
  commercialRegistrationNumber: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string;
  deliveryZones: { city: string; districts?: string[] }[];
  products: { slug: string; name: string; price: number }[];
};
