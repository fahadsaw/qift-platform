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

// Statuses the dashboard surfaces. Anything not in this set is hidden:
// pending_address (waiting on receiver) and delivered (terminal).
const DASHBOARD_STATUSES: GiftStatus[] = [
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

  // Latest-first feed of every gift the store still has work to do on.
  // Delivered orders fall out automatically; pending_address orders never
  // appear because the store has no business with them until the
  // receiver (or the 24h auto-default) picks an address.
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
  async markShipped(
    viewerUserId: string,
    giftId: string,
    opts: { trackingNumber?: string; carrier?: string } = {},
  ) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    await this.assertCanMutate(viewerUserId, gift.storeId);
    if (gift.status === 'shipped') return toSafeStoreMutationResult(gift);
    assertTransition(gift.status, 'shipped');

    const trackingNumber = opts.trackingNumber?.trim() || null;
    const carrier = opts.carrier?.trim() || null;

    const updated = await this.prisma.gift.update({
      where: { id: giftId },
      data: {
        status: 'shipped' satisfies GiftStatus,
        shippedAt: new Date(),
        trackingNumber,
        carrier,
      },
    });

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
