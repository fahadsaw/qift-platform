import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationsService,
  NotificationType,
} from '../notifications/notifications.service';
import { assertTransition, type GiftStatus } from '../gifts/gift-status';
import { StoresService } from '../stores/stores.service';
import {
  SHIPPING_PROVIDERS,
  buildTrackingUrl,
  isKnownProvider,
  isShipmentStatus,
  type ShipmentStatus,
} from './shipping-providers';

// What the dashboard renders per row. The store NEEDS the receiver's
// physical address to ship, so this is the one place address fields
// cross the wire to a non-owner. Access is gated by StoreGuard.
//
// PRIVACY: the buyer's gift message + media URL are intentionally NOT
// exposed here. Only the sender + receiver (post-delivery) ever see
// those fields — the store's role is courier handoff, not snooping on
// personal notes. The select clause below also omits them so even
// accidental serialisation can't leak.
//
// We expose BOTH the formatted single-line address (for the card
// subtitle / copy-to-clipboard) AND the raw fields (for the order
// details modal that splits the address into labelled rows). The raw
// fields stay nullable because country-specific schemas only fill the
// columns that apply (e.g. KW uses `governorate`, not `region`).
export type StoreOrderRow = {
  giftId: string;
  productName: string;
  storeName: string;
  receiverName: string;
  // Single-line, Arabic-comma formatted address built server-side.
  address: string;
  deliveryPhone: string | null;
  // Raw address columns for the details modal. All nullable so
  // country-specific schemas don't have to fake fields.
  region: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  buildingNumber: string | null;
  status: GiftStatus;
  trackingNumber: string | null;
  carrier: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  shippedAt: Date | null;
};

const ANONYMOUS_BUYER_NOTE = 'مرسل مجهول';

// Mutation responses returned to the store. We enumerate the allowed
// fields by name (NOT spread `...gift`) so a future schema column added
// to Gift can't silently leak into a store-facing response. messageText,
// mediaUrl, mediaType, addressId, sender/receiver identities, etc. are
// all intentionally excluded.
export type StoreMutationResult = {
  giftId: string;
  status: GiftStatus;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  trackingNumber: string | null;
  carrier: string | null;
};

function toSafeStoreMutationResult(g: {
  id: string;
  status: string;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  trackingNumber: string | null;
  carrier: string | null;
}): StoreMutationResult {
  return {
    giftId: g.id,
    status: g.status as GiftStatus,
    shippedAt: g.shippedAt,
    deliveredAt: g.deliveredAt,
    trackingNumber: g.trackingNumber,
    carrier: g.carrier,
  };
}

// Statuses the dashboard surfaces.
//
// `pending_address` is included intentionally: a paid gift sits in
// this state until the receiver picks an address (or the 24h auto-
// default fires). The merchant has been paid for the order and is
// owed visibility — they can see the row exists, plan capacity, and
// know "an order is on its way to me", even though they can't act
// on it (the address row is null pre-confirmation, so the
// formatAddress() call returns "—" and deliveryPhone is null). The
// merchant action endpoints reject any prepare/ship/deliver attempt
// against pending_address rows because the gift-status transition
// graph forbids it; the row stays visible-but-inert until the
// recipient resolves the address.
//
// `delivered` is excluded because it's the terminal happy state —
// the merchant's work is done, and keeping the row in the live feed
// would just clutter the queue. Historical view of delivered gifts
// is a separate (future) endpoint.
const DASHBOARD_STATUSES: GiftStatus[] = [
  'pending_address',
  'address_confirmed',
  'default_address_used',
  'preparing',
  'shipped',
];

@Injectable()
export class StoreService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private stores: StoresService,
  ) {}

  // Resolve which store ids the dashboard caller can see. Uses the
  // STORE_USER_IDS escape hatch first (legacy admin override — see
  // store.guard.ts), then falls back to "every Store this user owns".
  // Returns `null` for the admin override to mean "no scoping at all".
  private async scopedStoreIds(viewerUserId: string): Promise<string[] | null> {
    const allowList = (process.env.STORE_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowList.includes(viewerUserId)) return null;
    return this.stores.ownedStoreIds(viewerUserId);
  }

  // Latest-first feed of every gift the store has either an open
  // workload on (address_confirmed → shipped) or visibility-only
  // interest in (pending_address — paid, awaiting recipient).
  // Delivered orders fall out automatically (terminal happy state).
  //
  // Privacy on pending_address rows:
  //   - The Gift hasn't picked an address yet, so `gift.address` is
  //     null. The mapping below already null-coalesces every address
  //     field to '—' / null, so a pending row carries NO recipient
  //     location data. The receiver's name + phone are exposed only
  //     as far as the existing post-confirmation rows already do —
  //     for pending rows phone stays null because the address row
  //     is the source of truth and it doesn't exist yet.
  //   - The store sees product name + timestamp + receiver name. No
  //     address, no phone, no message, no media. This matches the
  //     spec: "Awaiting recipient address" view.
  //
  // Scoping rule:
  //   - admin override (STORE_USER_IDS env) → see ALL in-flight orders
  //   - otherwise → only orders whose `storeId` belongs to the viewer
  // Cross-store leakage is prevented by the storeId filter; if the
  // viewer owns no stores the list is empty.
  async listOrders(viewerUserId: string): Promise<StoreOrderRow[]> {
    const storeIds = await this.scopedStoreIds(viewerUserId);
    const gifts = await this.prisma.gift.findMany({
      where: {
        status: { in: DASHBOARD_STATUSES },
        ...(storeIds === null ? {} : { storeId: { in: storeIds } }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        receiver: { select: { fullName: true, qiftUsername: true } },
        address: true,
      },
    });

    return gifts.map((g) => ({
      giftId: g.id,
      productName: g.productName,
      storeName: g.storeName,
      receiverName:
        g.receiver?.fullName?.trim() ||
        g.receiver?.qiftUsername ||
        ANONYMOUS_BUYER_NOTE,
      // Privacy: messageText / mediaUrl / mediaType are intentionally
      // omitted. The store doesn't need them to ship the package, and
      // the spec forbids us from leaking buyer-to-receiver content.
      address: g.address ? formatAddress(g.address) : '—',
      deliveryPhone: g.address?.deliveryPhone ?? null,
      // Raw address fields. Null when the gift has no linked address row
      // (legacy data before the addressId FK existed).
      region: g.address?.region ?? null,
      city: g.address?.city ?? null,
      district: g.address?.district ?? null,
      street: g.address?.street ?? null,
      buildingNumber: g.address?.buildingNumber ?? null,
      status: g.status as GiftStatus,
      trackingNumber: g.trackingNumber,
      carrier: g.carrier,
      createdAt: g.createdAt,
      confirmedAt: g.confirmedAt,
      shippedAt: g.shippedAt,
    }));
  }

  // Cross-store ownership guard. Throws 403 if the JWT viewer doesn't
  // own the store this gift belongs to. The admin override (env list)
  // skips the check so legacy / staging flows still work.
  private async assertCanMutate(
    viewerUserId: string,
    giftStoreId: string | null,
  ) {
    const allowList = (process.env.STORE_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowList.includes(viewerUserId)) return;
    // Legacy gifts without storeId can't be tied to any store; only the
    // admin override can mutate them. Otherwise refuse so a tampered
    // request can't drift unowned rows around.
    if (!giftStoreId) {
      throw new ForbiddenException('هذا الطلب لا يخص أي من متاجرك');
    }
    const owned = await this.stores.ownedStoreIds(viewerUserId);
    if (!owned.includes(giftStoreId)) {
      throw new ForbiddenException('هذا الطلب لا يخص أي من متاجرك');
    }
  }

  // address_confirmed | default_address_used → preparing
  async markPreparing(viewerUserId: string, giftId: string) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    await this.assertCanMutate(viewerUserId, gift.storeId);
    // Idempotent: same-state writes short-circuit without re-touching the
    // row. We still scrub through the safe shape so the response stays
    // consistent with the post-mutation path.
    if (gift.status === 'preparing') return toSafeStoreMutationResult(gift);
    assertTransition(gift.status, 'preparing');

    const updated = await this.prisma.gift.update({
      where: { id: giftId },
      data: { status: 'preparing' satisfies GiftStatus },
    });

    void this.notifications.trigger({
      userId: gift.receiverId,
      type: NotificationType.GiftPreparing,
      title: 'هديتك قيد التجهيز',
      body: updated.productName,
      link: `/gifts/${gift.id}`,
    });
    void this.notifications.trigger({
      userId: gift.senderId,
      type: NotificationType.GiftPreparing,
      title: 'الهدية قيد التجهيز لدى المتجر',
      body: updated.productName,
      link: `/gifts/${gift.id}`,
    });

    return toSafeStoreMutationResult(updated);
  }

  // preparing → shipped. Optional `trackingNumber` + `carrier` get persisted
  // alongside the timestamp so the receiver can follow the package.
  // When `provider` is supplied, we also create/update a Shipment row
  // with an initial `registered` event so the rich timeline UI has
  // something to render. Pre-shipment legacy fields (Gift.trackingNumber
  // / Gift.carrier) stay in sync so older clients keep working.
  async markShipped(
    viewerUserId: string,
    giftId: string,
    opts: {
      trackingNumber?: string;
      carrier?: string;
      provider?: string;
    } = {},
  ) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    await this.assertCanMutate(viewerUserId, gift.storeId);
    if (gift.status === 'shipped') return toSafeStoreMutationResult(gift);
    assertTransition(gift.status, 'shipped');

    const trackingNumber = opts.trackingNumber?.trim() || null;
    const rawProvider = opts.provider?.trim() || null;
    // `carrier` is the human-readable label persisted on Gift for
    // backwards-compat. `provider` is the stable code persisted on
    // Shipment. We accept either input and derive the other.
    const provider =
      rawProvider && isKnownProvider(rawProvider) ? rawProvider : null;
    const carrier =
      opts.carrier?.trim() ||
      (provider
        ? (SHIPPING_PROVIDERS.find((p) => p.code === provider)?.nameAr ?? null)
        : null);

    const updated = await this.prisma.gift.update({
      where: { id: giftId },
      data: {
        status: 'shipped' satisfies GiftStatus,
        shippedAt: new Date(),
        trackingNumber,
        carrier,
      },
    });

    // Create the Shipment row when we know which provider; the
    // tracking-URL template renders the deep-link the receiver
    // will open. If no provider was supplied, we skip the
    // shipment row — a future "Add tracking" merchant action
    // can fill it in (POST /store/orders/:id/shipment).
    if (provider) {
      const trackingUrl = buildTrackingUrl(provider, trackingNumber);
      const now = new Date();
      await this.prisma.shipment.upsert({
        where: { giftId },
        create: {
          giftId,
          provider,
          trackingNumber,
          trackingUrl,
          status: 'registered' satisfies ShipmentStatus,
          events: {
            create: {
              status: 'registered' satisfies ShipmentStatus,
              note: trackingNumber ? `Tracking ${trackingNumber}` : null,
              occurredAt: now,
            },
          },
        },
        update: {
          provider,
          trackingNumber,
          trackingUrl,
          status: 'registered' satisfies ShipmentStatus,
        },
      });
    }

    // Deep-link both notifications to the specific gift so receiver
    // and sender land directly on the timeline / tracking row.
    const shippedLink = `/gifts/${gift.id}`;
    void this.notifications.trigger({
      userId: gift.receiverId,
      type: NotificationType.GiftShipped,
      title: 'تم شحن هديتك 🚚',
      body: updated.productName,
      link: shippedLink,
    });
    void this.notifications.trigger({
      userId: gift.senderId,
      type: NotificationType.GiftShipped,
      title: 'تم شحن الهدية',
      body: updated.productName,
      link: shippedLink,
    });

    return toSafeStoreMutationResult(updated);
  }

  // Read the shipment + timeline for one gift. Used by both the
  // merchant order-detail view and the receiver/sender gift-
  // tracking page (read access for those is gated separately by
  // GiftsService). Returns null when no Shipment row exists yet —
  // legacy gifts shipped before this feature, or gifts that
  // haven't been handed off yet.
  async getShipmentForOrder(viewerUserId: string, giftId: string) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    await this.assertCanMutate(viewerUserId, gift.storeId);
    const shipment = await this.prisma.shipment.findUnique({
      where: { giftId },
      include: {
        events: { orderBy: { occurredAt: 'asc' } },
      },
    });
    if (!shipment) {
      // No shipment row yet. Surface the legacy Gift.trackingNumber
      // / Gift.carrier so the merchant UI can decide whether to
      // offer "Add tracking" or "Already entered the simple
      // fields, do you want to upgrade to a full Shipment?"
      return {
        shipment: null,
        legacyTrackingNumber: gift.trackingNumber,
        legacyCarrier: gift.carrier,
      };
    }
    return { shipment, legacyTrackingNumber: null, legacyCarrier: null };
  }

  // Create or update the Shipment row outside of the markShipped
  // path. Used when the merchant wants to add tracking to an
  // already-shipped gift, or upgrade a legacy carrier-string row
  // to a structured Shipment.
  async upsertShipment(
    viewerUserId: string,
    giftId: string,
    body: { provider: string; trackingNumber?: string },
  ) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    await this.assertCanMutate(viewerUserId, gift.storeId);
    const provider = body.provider?.trim();
    if (!provider || !isKnownProvider(provider)) {
      throw new ForbiddenException('مزود الشحن غير معروف');
    }
    const trackingNumber = body.trackingNumber?.trim() || null;
    const trackingUrl = buildTrackingUrl(provider, trackingNumber);
    const now = new Date();
    const shipment = await this.prisma.shipment.upsert({
      where: { giftId },
      create: {
        giftId,
        provider,
        trackingNumber,
        trackingUrl,
        status: 'registered' satisfies ShipmentStatus,
        events: {
          create: {
            status: 'registered' satisfies ShipmentStatus,
            note: trackingNumber ? `Tracking ${trackingNumber}` : null,
            occurredAt: now,
          },
        },
      },
      update: {
        provider,
        trackingNumber,
        trackingUrl,
      },
      include: { events: { orderBy: { occurredAt: 'asc' } } },
    });
    // Mirror the human-readable carrier name onto the Gift row so
    // pre-shipment-feature consumers (and the dashboard list)
    // continue to see the right label.
    const display =
      SHIPPING_PROVIDERS.find((p) => p.code === provider)?.nameAr ?? null;
    if (display !== gift.carrier || trackingNumber !== gift.trackingNumber) {
      await this.prisma.gift.update({
        where: { id: giftId },
        data: { carrier: display, trackingNumber },
      });
    }
    return shipment;
  }

  // Append a tracking event to an existing Shipment. Status must
  // be one of the SHIPMENT_STATUSES literals; note is operator
  // free-text (still public — never include receiver address
  // detail). The Shipment.status field is set to the latest event
  // for cheap "what's the current state?" reads.
  async appendShipmentEvent(
    viewerUserId: string,
    giftId: string,
    body: { status: string; note?: string; occurredAt?: string },
  ) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    await this.assertCanMutate(viewerUserId, gift.storeId);
    const shipment = await this.prisma.shipment.findUnique({
      where: { giftId },
    });
    if (!shipment) throw new NotFoundException('No shipment for this order');
    const status = body.status?.trim() ?? '';
    if (!isShipmentStatus(status)) {
      throw new ForbiddenException('حالة الشحن غير معروفة');
    }
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
    const note = body.note?.trim() || null;
    await this.prisma.shipmentEvent.create({
      data: { shipmentId: shipment.id, status, note, occurredAt },
    });
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { status },
    });
    // If the merchant marks "delivered" via the timeline, mirror
    // it onto the Gift status so the receiver sees the gift as
    // delivered without needing a separate POST. The transition
    // is gated by gift-status.assertTransition so an out-of-
    // order push is rejected.
    if (status === 'delivered' && gift.status !== 'delivered') {
      try {
        assertTransition(gift.status, 'delivered');
        await this.prisma.gift.update({
          where: { id: giftId },
          data: { status: 'delivered', deliveredAt: occurredAt },
        });
      } catch {
        // Out-of-order — don't fail the event append, just skip
        // the Gift.status mirror. The merchant can still mark
        // delivered via the explicit /delivered endpoint.
      }
    }
    return this.getShipmentForOrder(viewerUserId, giftId);
  }

  // ── Analytics ─────────────────────────────────────────────
  // Aggregations over every Gift the viewer's stores own. Counts
  // per status, revenue per time window, top-N products, and
  // delivery success rate. The payout calculation lives in
  // getPayouts() so analytics stays a pure read.
  //
  // Revenue source = Order.totalAmount for every gift's linked
  // order, scoped to delivered + in-progress states (we count
  // money the merchant has been paid for OR will be paid for —
  // cancelled is excluded). Today's / week's / month's windows
  // use UTC start-of-period bounds; the small drift on edge
  // timezones is acceptable for a dashboard summary.
  async getAnalytics(viewerUserId: string) {
    const storeIds = await this.scopedStoreIds(viewerUserId);
    const giftWhere =
      storeIds === null
        ? {}
        : storeIds.length === 0
          ? { id: 'never-matches' }
          : { storeId: { in: storeIds } };

    const [totalGifts, statusGroups, productGroups, gifts] = await Promise.all([
      this.prisma.gift.count({ where: giftWhere }),
      this.prisma.gift.groupBy({
        by: ['status'],
        where: giftWhere,
        _count: { _all: true },
      }),
      // Top products by gift count, capped server-side.
      this.prisma.gift.groupBy({
        by: ['productName'],
        where: giftWhere,
        _count: { _all: true },
        orderBy: { _count: { productName: 'desc' } },
        take: 5,
      }),
      // Pull just the createdAt + giftId for the per-window
      // revenue join. Pulling Gifts and Orders separately keeps
      // the SQL simple; we're rarely above a few hundred rows
      // per merchant in the early phase.
      this.prisma.gift.findMany({
        where: giftWhere,
        select: { id: true, createdAt: true, status: true },
      }),
    ]);

    const giftIds = gifts.map((g) => g.id);
    const orders = giftIds.length
      ? await this.prisma.order.findMany({
          where: { giftId: { in: giftIds } },
          select: {
            giftId: true,
            totalAmount: true,
            productPrice: true,
            createdAt: true,
          },
        })
      : [];
    const orderByGift = new Map<string, (typeof orders)[number]>();
    for (const o of orders) {
      if (o.giftId) orderByGift.set(o.giftId, o);
    }

    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const startOfWeek = new Date(
      startOfToday.getTime() - startOfToday.getUTCDay() * 86_400_000,
    );
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    let revenueAllTime = 0;
    let revenueToday = 0;
    let revenueWeek = 0;
    let revenueMonth = 0;
    let paidGiftCount = 0;
    for (const g of gifts) {
      // Cancelled = not paid (refunded). Skip from revenue.
      if (g.status === 'cancelled') continue;
      const order = orderByGift.get(g.id);
      const amount = order?.totalAmount ?? 0;
      if (!amount) continue;
      revenueAllTime += amount;
      paidGiftCount += 1;
      const created = new Date(g.createdAt);
      if (created >= startOfToday) revenueToday += amount;
      if (created >= startOfWeek) revenueWeek += amount;
      if (created >= startOfMonth) revenueMonth += amount;
    }

    const statusCounts: Record<string, number> = {
      pending_address: 0,
      address_confirmed: 0,
      default_address_used: 0,
      preparing: 0,
      shipped: 0,
      delivered: 0,
      cancelled: 0,
    };
    for (const sg of statusGroups) {
      statusCounts[sg.status] = sg._count._all;
    }

    const deliveredCount = statusCounts.delivered ?? 0;
    const cancelledCount = statusCounts.cancelled ?? 0;
    const successDenominator = deliveredCount + cancelledCount;
    const deliverySuccessRate = successDenominator
      ? Math.round((deliveredCount / successDenominator) * 1000) / 10
      : null;

    const avgOrderValue = paidGiftCount
      ? Math.round((revenueAllTime / paidGiftCount) * 100) / 100
      : 0;

    return {
      totalOrders: totalGifts,
      statusCounts,
      revenue: {
        today: round2(revenueToday),
        week: round2(revenueWeek),
        month: round2(revenueMonth),
        allTime: round2(revenueAllTime),
      },
      avgOrderValue,
      deliverySuccessRate,
      topProducts: productGroups.map((p) => ({
        productName: p.productName,
        count: p._count._all,
      })),
    };
  }

  // ── Payouts ────────────────────────────────────────────────
  // Mock settlement breakdown. Computed from existing Orders;
  // there's no real gateway hookup yet, so all gross revenue
  // shows as "pending". Once we wire a settlement record table,
  // `paid` will reflect it and `pending` will be the difference.
  //
  // Per-order rows give the merchant a line-item view they can
  // reconcile against future bank statements.
  async getPayouts(viewerUserId: string) {
    const storeIds = await this.scopedStoreIds(viewerUserId);
    const giftWhere =
      storeIds === null
        ? {}
        : storeIds.length === 0
          ? { id: 'never-matches' }
          : { storeId: { in: storeIds } };

    const gifts = await this.prisma.gift.findMany({
      where: giftWhere,
      select: { id: true, productName: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const giftIds = gifts.map((g) => g.id);
    const orders = giftIds.length
      ? await this.prisma.order.findMany({
          where: { giftId: { in: giftIds } },
          select: {
            giftId: true,
            totalAmount: true,
            productPrice: true,
            serviceFee: true,
            deliveryFee: true,
            currency: true,
            createdAt: true,
          },
        })
      : [];
    const orderByGift = new Map<string, (typeof orders)[number]>();
    for (const o of orders) {
      if (o.giftId) orderByGift.set(o.giftId, o);
    }

    const PLATFORM_FEE_PCT = 0.03; // matches checkout serviceFee target
    let grossRevenue = 0;
    let platformFees = 0;
    let deliveryFees = 0;
    let netPayable = 0;
    let currency = 'SAR';
    const items: Array<{
      giftId: string;
      productName: string;
      status: GiftStatus;
      gross: number;
      platformFee: number;
      deliveryFee: number;
      net: number;
      currency: string;
      createdAt: Date;
    }> = [];

    for (const g of gifts) {
      const order = orderByGift.get(g.id);
      const gross = order?.totalAmount ?? 0;
      const fee =
        order?.serviceFee ?? Math.round(gross * PLATFORM_FEE_PCT * 100) / 100;
      const delivery = order?.deliveryFee ?? 0;
      const net = round2(gross - fee - delivery);
      if (order?.currency) currency = order.currency;
      // Cancelled rows are surfaced for transparency but contribute
      // nothing to the totals — refund flow zeroes the order.
      if (g.status !== 'cancelled') {
        grossRevenue += gross;
        platformFees += fee;
        deliveryFees += delivery;
        netPayable += net;
      }
      items.push({
        giftId: g.id,
        productName: g.productName,
        status: g.status as GiftStatus,
        gross: round2(gross),
        platformFee: round2(fee),
        deliveryFee: round2(delivery),
        net,
        currency: order?.currency ?? currency,
        createdAt: g.createdAt,
      });
    }

    return {
      currency,
      grossRevenue: round2(grossRevenue),
      platformFees: round2(platformFees),
      deliveryFees: round2(deliveryFees),
      netPayable: round2(netPayable),
      // Real settlement is future work. Today everything sits as
      // pending so the merchant can see what they're owed; once
      // we have a Payout record the math will split.
      paid: 0,
      pending: round2(netPayable),
      items,
      platformFeePercent: PLATFORM_FEE_PCT * 100,
    };
  }

  listShippingProviders() {
    return SHIPPING_PROVIDERS;
  }

  // shipped → delivered. This is now the ONLY path to delivered; the user-
  // facing button was removed in v3 so transitions stay strict.
  async markDelivered(viewerUserId: string, giftId: string) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    await this.assertCanMutate(viewerUserId, gift.storeId);
    if (gift.status === 'delivered') return toSafeStoreMutationResult(gift);
    assertTransition(gift.status, 'delivered');

    const updated = await this.prisma.gift.update({
      where: { id: giftId },
      data: {
        status: 'delivered' satisfies GiftStatus,
        deliveredAt: new Date(),
      },
    });

    // Per-recipient delivery copy (Gift message v3):
    //   - Receiver: "لديك رسالة من مرسل الهدية 💌" — celebratory; the
    //     message reveal gate flips and they can now read what was sent.
    //   - Sender:   "تم استلام هديتك بنجاح 🎉" — confirmation that the
    //     other side actually received it.
    const deliveredLink = `/gifts/${gift.id}`;
    void this.notifications.trigger({
      userId: gift.receiverId,
      type: NotificationType.GiftDelivered,
      title: 'لديك رسالة من مرسل الهدية 💌',
      body: updated.productName,
      link: deliveredLink,
    });
    void this.notifications.trigger({
      userId: gift.senderId,
      type: NotificationType.GiftDelivered,
      title: 'تم استلام هديتك بنجاح 🎉',
      body: updated.productName,
      link: deliveredLink,
    });

    return toSafeStoreMutationResult(updated);
  }
}

// Round to 2 decimal places without floating-point noise. Used
// throughout the analytics/payouts paths so dashboard money
// values render as whole hallalahs / cents.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Stitch the granular columns into a single courier-friendly line.
// Output format mirrors the spec example:
//   "الرياض، النرجس، شارع الملك سلمان، مبنى 1234"
//
// Rules:
//   - Arabic comma + space ("، ") between parts.
//   - Building number is prefixed with "مبنى " (RTL-friendly word).
//   - Unit number, when present, is prefixed with "وحدة ".
//   - Empty / null parts are dropped silently — we never emit "،  ، ".
//   - Falls back to the legacy `details` blob when no granular fields
//     exist (older addresses created before the v2 schema).
//
// Exported so the gift detail UI on the receiver side can render the
// same string without re-implementing the algorithm.
export function formatAddress(addr: {
  region: string | null;
  governorate: string | null;
  city: string;
  district: string;
  street: string | null;
  buildingNumber: string | null;
  unitNumber: string | null;
  postalCode: string | null;
  details: string;
}): string {
  const parts = [
    addr.region,
    addr.governorate,
    addr.city,
    addr.district,
    addr.street,
    addr.buildingNumber ? `مبنى ${addr.buildingNumber}` : null,
    addr.unitNumber ? `وحدة ${addr.unitNumber}` : null,
    addr.postalCode,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  if (parts.length) return parts.join('، ');
  return addr.details?.trim() || '—';
}
