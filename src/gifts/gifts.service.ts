import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationsService,
  NotificationType,
} from '../notifications/notifications.service';
import { assertTransition, type GiftStatus } from './gift-status';
import {
  applyGiftVisibility,
  validateGiftMedia,
  type GiftLike,
} from './gift-visibility';
import { getDefaultAddressForUser } from '../addresses/default-address.helper';
import { matchAddressToStoreZones } from '../stores/delivery-zones';
export type { GiftStatus } from './gift-status';

// Categories whose products spoil or are time-sensitive, and
// therefore must match the store's configured delivery zones.
// Mirrors the frontend's lib/sampleData.FAST_DELIVERY_CATEGORIES.
const FAST_DELIVERY_CATEGORIES: ReadonlySet<string> = new Set([
  'flowers',
  'chocolate',
  'cake',
  'perishable',
]);

// `senderId` is intentionally omitted — we always use the JWT viewer as the
// sender, so a client-supplied senderId would be ignored anyway.
export type CreateGiftInput = {
  receiverUsername?: string;
  productName?: string;
  storeName?: string;
  // Buyer's gift message. Accepts the new `messageText` field name; the
  // legacy `message` alias is also accepted to keep older callers (and
  // PaymentsService) working without a coordinated rename.
  messageText?: string;
  message?: string;
  // Optional media attachment. `mediaType` discriminates the renderer
  // on the receiver side. Both fields are subject to the same delivery-
  // time reveal gate as `messageText`.
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  isAnonymous?: boolean;
  // Sender-controlled surprise mode. When true, the receiver gets a
  // mystery notification and `productName`/`storeName` are masked from
  // their view of the gift until status === 'delivered'. Default false
  // (visible immediately) — same semantics as before this flag existed.
  isSurprise?: boolean;
  // Fast-delivery context (flowers/chocolate/cake/perishables). Mirrors
  // the OrdersService contract; we re-validate here so direct POSTs to
  // /gifts can't bypass the city-match guard.
  isFastDelivery?: boolean;
  storeCity?: string;
  // Catalog identifiers — propagated from Order via PaymentsService so
  // the Gift inherits the right FKs and the store dashboard can filter.
  productId?: string;
  storeId?: string;
};

const PARTY_SELECT = {
  id: true,
  qiftUsername: true,
  fullName: true,
};

const ADDRESS_SELECT = {
  id: true,
  label: true,
  country: true,
  region: true,
  city: true,
  governorate: true,
  district: true,
  street: true,
  buildingNumber: true,
  unitNumber: true,
  postalCode: true,
  additionalNumber: true,
  shortAddress: true,
  deliveryPhone: true,
  details: true,
  isDefault: true,
};

const GIFT_INCLUDE = {
  sender: { select: PARTY_SELECT },
  receiver: { select: PARTY_SELECT },
  address: { select: ADDRESS_SELECT },
};

const FORBIDDEN_MSG = 'غير مصرح لك';

// `GiftWithParties` is the shape Prisma returns when we include sender +
// receiver. We re-export the type from the visibility module so every
// helper agrees on the field names and tightening one place propagates
// everywhere.
type GiftWithParties = GiftLike;

@Injectable()
export class GiftsService {
  private readonly logger = new Logger(GiftsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async create(body: CreateGiftInput, viewerUserId: string) {
    // Sender is always the authenticated user — never trust client input.
    const senderId = viewerUserId;
    const receiverUsername = body.receiverUsername?.trim().toLowerCase();
    const productName = body.productName?.trim();
    const storeName = body.storeName?.trim();
    // Accept either the new `messageText` name or the legacy `message`
    // alias. Both PaymentsService (forwarding from Order.message) and
    // older direct callers keep working without coordinated updates.
    const messageText =
      body.messageText?.trim() || body.message?.trim() || null;
    // Media validation lives in gift-visibility.ts so a future upload
    // endpoint can reuse the exact same rules. Throws BadRequestException
    // when (mediaUrl, mediaType) is inconsistent.
    const { mediaUrl, mediaType } = validateGiftMedia(
      body.mediaUrl,
      body.mediaType,
    );
    const isAnonymous = body.isAnonymous === true;
    const isSurprise = body.isSurprise === true;

    if (!receiverUsername || !productName || !storeName) {
      throw new BadRequestException(
        'receiverUsername, productName and storeName are required',
      );
    }

    // Self-send guard: look up sender's username and compare.
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { qiftUsername: true },
    });
    if (!sender) {
      throw new NotFoundException('Sender not found');
    }
    if (sender.qiftUsername.toLowerCase() === receiverUsername) {
      throw new BadRequestException('لا يمكنك إرسال هدية لنفسك');
    }

    const receiver = await this.prisma.user.findFirst({
      where: { qiftUsername: receiverUsername, deletedAt: null },
      select: { id: true },
    });
    if (!receiver) {
      throw new NotFoundException('Receiver not found');
    }
    // Canonical default-address resolver. Same helper as
    // /users/check?username=, so the pre-flight gate and the create
    // gate can never disagree on whether a recipient is ready.
    const defaultAddress = await getDefaultAddressForUser(
      this.prisma,
      receiver.id,
    );
    if (process.env.GIFT_FLOW_DEBUG === '1') {
      const totalCount = await this.prisma.address.count({
        where: { userId: receiver.id },
      });
      const defaultCount = await this.prisma.address.count({
        where: { userId: receiver.id, isDefault: true },
      });
      this.logger.log(
        `[gift-flow] gifts.create receiverId=${receiver.id} username="${receiverUsername}" addressCount=${totalCount} defaultCount=${defaultCount} resolvedDefaultId=${defaultAddress?.id ?? null}`,
      );
    }

    // Recipient must have a default delivery address before any gift
    // can land. This is the hard guard mirroring the /send page warning
    // and the same gate is duplicated in OrdersService.create — both
    // sides have to enforce it because a buyer who calls POST /gifts
    // directly skips OrdersService entirely.
    //
    // We keep this rule strict on purpose: without a default address
    // the store order can sit indefinitely waiting on the recipient,
    // creating refund headaches for the buyer and operational issues
    // for the merchant. Better to fail fast with clear UI copy than
    // to charge first and untangle later.
    //
    // When this trips we ALSO:
    //   1. Record a GiftAttempt row so we can notify the sender later
    //      (when the recipient finally sets a default address).
    //   2. Fire a recipient-side notification asking them to add one.
    //
    // Both side-effects are best-effort and never roll back the 422.
    // The `code` is stable so the frontend can map it to the localized
    // copy without string-matching the message.
    if (!defaultAddress) {
      try {
        await this.prisma.giftAttempt.create({
          data: {
            senderId,
            receiverId: receiver.id,
            receiverUsername,
            productName,
            storeName,
          },
        });
      } catch {
        // Don't let attempt-logging failure mask the real 422 below.
      }
      void this.notifications.trigger({
        userId: receiver.id,
        type: NotificationType.GiftAttemptedNoAddress,
        title:
          'حاول شخص إرسال هدية لك، لكن لا يمكنك استلامها قبل تحديد عنوان افتراضي',
        body: null,
        link: '/profile',
      });
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          // Stable machine-readable code — frontend switches on this.
          // Renamed from `receiver_no_default_address` for consistency
          // with the rest of the codebase (we say "recipient" in
          // copy + comments). The old name is no longer emitted; if
          // an operator needs it we'd add a temporary alias here.
          code: 'recipient_no_default_address',
          message:
            'المستلم لم يحدد عنوانًا افتراضيًا بعد، لذلك لا يمكن إرسال الهدية له حاليًا.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Fast-delivery gate. We don't have UsersService injected here (would
    // be a circular import via OrdersModule), so we run the same privacy-
    // safe city check inline. The error message stays generic — it never
    // names a city.
    if (body.isFastDelivery === true) {
      const storeCity = body.storeCity?.trim();
      if (!storeCity) {
        throw new BadRequestException(
          'storeCity is required for fast-delivery products',
        );
      }
      const ok = await canDeliverFastInline(
        this.prisma,
        receiver.id,
        storeCity,
      );
      if (!ok) {
        throw new BadRequestException('لا يمكن التوصيل لهذا المستخدم');
      }
    }

    // Out-of-stock guard, defensive duplicate of OrdersService. Inline
    // (no ProductsService injection) to avoid a module-import cycle:
    // GiftsModule already imports NotificationsModule, and Products
    // depends on Stores, so adding it here would create a fragile graph.
    //
    // Also returns the product's owning storeId — used as a server-
    // side fallback when the caller's `storeId` is missing. Mirrors
    // the same fix applied to OrdersService so a direct POST /gifts
    // (admin tooling, integration tests) also gets correct merchant
    // linkage. Without this fallback, gifts created via the sender-
    // facing GiftsController.create() route (no payment flow) would
    // be permanently invisible on /store/orders.
    let productInfoStoreId: string | null = null;
    if (body.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: body.productId },
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
      productInfoStoreId = product.storeId;
    }

    // Resolve storeId. Preference order matches OrdersService:
    //   1. body.storeId — caller-supplied (forwarded from Order at
    //      payment-confirm, or supplied directly by an admin path).
    //   2. product.storeId — server-side derivation from the catalog.
    //   3. null — legacy / sample-product path; the gift stays
    //      unlinked from any merchant.
    const storeIdFromBody = body.storeId?.trim() || null;
    const resolvedStoreId = storeIdFromBody ?? productInfoStoreId;

    // Order-flow debug logging. Toggled by ORDER_FLOW_DEBUG=1 on
    // the API process. Mirrors the OrdersService log so the
    // operator can read both halves of "who set storeId where"
    // when chasing a missing-merchant-order report. Privacy-safe:
    // ids + flags only.
    if (process.env.ORDER_FLOW_DEBUG === '1') {
      this.logger.log(
        `[order-flow] gifts.create senderId=${senderId} ` +
          `bodyProductId=${body.productId ?? 'null'} ` +
          `bodyStoreId=${storeIdFromBody ?? 'null'} ` +
          `productStoreId=${productInfoStoreId ?? 'null'} ` +
          `resolvedStoreId=${resolvedStoreId ?? 'null'} ` +
          `linked=${resolvedStoreId ? 'YES' : 'NO'}`,
      );
    }

    const created = await this.prisma.gift.create({
      data: {
        senderId,
        receiverId: receiver.id,
        productName,
        storeName,
        // Persist catalog identifiers when available so the per-store
        // dashboard can filter on storeId. Legacy / sample-product flows
        // pass nothing and these stay null.
        storeId: resolvedStoreId,
        productId: body.productId?.trim() || null,
        messageText,
        mediaUrl,
        mediaType,
        isAnonymous,
        isSurprise,
        // Receiver still has to confirm or override the address.
        status: 'pending_address',
      },
      include: GIFT_INCLUDE,
    });

    if (process.env.ORDER_FLOW_DEBUG === '1') {
      this.logger.log(
        `[order-flow] gifts.create persisted giftId=${created.id} ` +
          `productId=${created.productId ?? 'null'} ` +
          `storeId=${created.storeId ?? 'null'} ` +
          `status=${created.status}`,
      );
    }

    // Two notifications fire as soon as a gift is created:
    //   1. "you have a new gift" — celebratory (or mystery, when surprise)
    //   2. "please confirm the delivery address" — actionable
    // Both go to the receiver. The notifications service swallows errors
    // so a failed write here can never roll back the gift create.
    //
    // Surprise-mode privacy: the celebratory notification's `body` is
    // `${productName} — ${storeName}` for normal gifts, but for surprise
    // gifts that would leak the very thing we're hiding from the receiver.
    // We swap to a generic mystery title with no body, identical for
    // every surprise gift so even traffic-analysis can't infer the shop.
    // Deep-link straight to the new gift's detail page so the receiver
    // lands on the action card without hunting through a list. The list
    // route stays as a fallback for older notifications that pre-date
    // this change.
    const giftLink = `/gifts/${created.id}`;
    void this.notifications.trigger({
      userId: receiver.id,
      type: NotificationType.GiftReceived,
      title: isSurprise ? 'وصلتك هدية مفاجأة 🎁' : 'وصلتك هدية جديدة 🎁',
      body: isSurprise ? null : `${productName} — ${storeName}`,
      link: giftLink,
    });
    void this.notifications.trigger({
      userId: receiver.id,
      type: NotificationType.GiftConfirmAddress,
      title: 'يرجى تأكيد عنوان استلام الهدية',
      body: null,
      link: giftLink,
    });

    return created;
  }

  async findOne(giftId: string, viewerUserId: string) {
    const gift = await this.prisma.gift.findUnique({
      where: { id: giftId },
      include: GIFT_INCLUDE,
    });
    if (!gift) throw new NotFoundException('Gift not found');
    if (viewerUserId !== gift.senderId && viewerUserId !== gift.receiverId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    const visible = applyGiftVisibility(gift as GiftWithParties, viewerUserId);
    // Hydrate the coverage-snapshot fields the gift-detail picker
    // uses for per-address eligibility preview. These are
    // operationally needed: without them the receiver's frontend
    // canDeliverTo() falls through to "unknown coverage" mode,
    // doesn't warn before confirm, and the backend's coverage
    // gate fires on the actual submit with a generic toast. The
    // sender doesn't normally see this surface, but we include
    // them in both viewer paths for consistency.
    const [snapshot, shipmentInfo] = await Promise.all([
      this.loadCoverageSnapshot(gift.storeId, gift.productId),
      this.loadShipmentSnapshot(gift.id),
    ]);
    return { ...visible, ...snapshot, ...shipmentInfo };
  }

  // Resolve the (store.city, store.deliveryZones, product.category,
  // product.isFastDelivery) snapshot for a gift's coverage check.
  // Each component is independent: a gift with a deleted product
  // still gets store fields, and vice versa. Returns nulls when
  // both FKs are missing (sample / pre-v2 gifts).
  private async loadCoverageSnapshot(
    storeId: string | null,
    productId: string | null,
  ): Promise<{
    storeCity: string | null;
    deliveryZones: unknown;
    category: string | null;
    isFastDelivery: boolean | null;
  }> {
    const [store, product] = await Promise.all([
      storeId
        ? this.prisma.store.findUnique({
            where: { id: storeId },
            select: { city: true, deliveryZones: true },
          })
        : null,
      productId
        ? this.prisma.product.findUnique({
            where: { id: productId },
            select: { category: true, isFastDelivery: true },
          })
        : null,
    ]);
    let isFastDelivery: boolean | null = null;
    if (product) {
      isFastDelivery =
        product.isFastDelivery === true ||
        FAST_DELIVERY_CATEGORIES.has(product.category.toLowerCase());
    }
    return {
      storeCity: store?.city ?? null,
      deliveryZones: store?.deliveryZones ?? null,
      category: product?.category ?? null,
      isFastDelivery,
    };
  }

  // Read-only shipment timeline for the gift detail page. The
  // merchant owns the write side via /store/orders/:id/shipment*;
  // sender + receiver only need to see what's already there.
  //
  // PRIVACY: returns provider + trackingNumber + trackingUrl +
  // status + events (status + note + occurredAt only). No
  // recipient address detail; the merchant's free-text note is
  // already visible to them on creation, so surfacing it to the
  // sender/receiver is by design — operational transparency, not
  // leaked PII. If we ever start using the note field for
  // internal-only annotations the merchant UI gets a "private
  // note" toggle and this projection filters those out.
  private async loadShipmentSnapshot(giftId: string): Promise<{
    shipment: {
      provider: string;
      trackingNumber: string | null;
      trackingUrl: string | null;
      status: string;
      events: { status: string; note: string | null; occurredAt: Date }[];
    } | null;
  }> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { giftId },
      select: {
        provider: true,
        trackingNumber: true,
        trackingUrl: true,
        status: true,
        events: {
          orderBy: { occurredAt: 'asc' },
          select: { status: true, note: true, occurredAt: true },
        },
      },
    });
    return { shipment };
  }

  // Receiver locks in the delivery address. If they pass an addressId we
  // use that one (after verifying ownership); otherwise we fall back to
  // their default. This is the only `pending_address → address_confirmed`
  // path; the 24h auto-default sweep handles the alternate edge.
  //
  // Idempotency: a gift that's already past `pending_address` (because
  // the receiver double-clicked Confirm, the auto-default sweep got
  // there first, or the request retried after a successful response was
  // lost mid-flight) returns the current row unchanged instead of 400.
  // This is what the frontend optimistic-update pattern needs — a
  // network blip on the second tap shouldn't roll the receiver back to
  // a "Confirm address" CTA when their gift is already accepted.
  async confirmAddress(
    giftId: string,
    viewerUserId: string,
    addressId?: string,
  ) {
    const gift = await this.prisma.gift.findUnique({ where: { id: giftId } });
    if (!gift) throw new NotFoundException('Gift not found');
    if (gift.receiverId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    // Idempotent fast-path: the gift has already moved past pending. We
    // return the current snapshot (with visibility applied) instead of
    // throwing — the only legitimate caller is the receiver retrying.
    if (gift.status !== 'pending_address') {
      const fresh = await this.prisma.gift.findUnique({
        where: { id: giftId },
        include: GIFT_INCLUDE,
      });
      if (!fresh) throw new NotFoundException('Gift not found');
      const visible = applyGiftVisibility(
        fresh as GiftWithParties,
        viewerUserId,
      );
      const snapshot = await this.loadCoverageSnapshot(
        fresh.storeId,
        fresh.productId,
      );
      return { ...visible, ...snapshot };
    }
    assertTransition(gift.status, 'address_confirmed');

    let chosenAddressId: string | null = null;
    let chosenAddressCity: string | null = null;
    let chosenAddressDistrict: string | null = null;
    if (addressId) {
      const owned = await this.prisma.address.findFirst({
        where: { id: addressId, userId: viewerUserId },
        select: { id: true, city: true, district: true },
      });
      if (!owned) {
        throw new BadRequestException('العنوان غير موجود أو لا يخصك');
      }
      chosenAddressId = owned.id;
      chosenAddressCity = owned.city;
      chosenAddressDistrict = owned.district;
    } else {
      const def = await getDefaultAddressForUser(this.prisma, viewerUserId);
      if (!def) {
        throw new BadRequestException('لا يوجد عنوان افتراضي لتأكيده');
      }
      chosenAddressId = def.id;
      // Re-query for the city/district fields needed by the
      // coverage matcher. The shared helper only returns `id` so
      // we don't widen its contract for callers that don't need
      // the address details.
      const defFull = await this.prisma.address.findUnique({
        where: { id: def.id },
        select: { city: true, district: true },
      });
      chosenAddressCity = defFull?.city ?? null;
      chosenAddressDistrict = defFull?.district ?? null;
    }

    // Coverage gate. For fast-delivery products (flowers, chocolate,
    // cake, perishables) the address must fall inside one of the
    // store's configured delivery zones. Same source-of-truth shape
    // the merchant editor at /store-dashboard/coverage writes; we
    // tolerate the legacy single-`city` fallback when no zones are
    // saved. Anything outside the configured coverage is rejected
    // here — the merchant has been telling us which areas they
    // can't reach, and we're now respecting that.
    if (gift.storeId) {
      const store = await this.prisma.store.findUnique({
        where: { id: gift.storeId },
        select: { city: true, deliveryZones: true },
      });
      // Resolve fast-delivery from the linked product, falling back
      // to false when product context is missing (legacy/sample
      // gifts whose Product row was never linked). We don't infer
      // it from `productName` — the category is the authoritative
      // source.
      let isFastDelivery = false;
      if (gift.productId) {
        const product = await this.prisma.product.findUnique({
          where: { id: gift.productId },
          select: { category: true, isFastDelivery: true },
        });
        if (product) {
          isFastDelivery =
            product.isFastDelivery === true ||
            FAST_DELIVERY_CATEGORIES.has(product.category.toLowerCase());
        }
      }
      if (store && isFastDelivery) {
        const match = matchAddressToStoreZones(
          { city: chosenAddressCity, district: chosenAddressDistrict },
          { city: store.city, deliveryZones: store.deliveryZones },
          true,
        );
        if (!match.ok) {
          // Structured error: the frontend's gift-detail picker maps
          // `code: 'address_unsupported_for_store'` to a specific
          // toast that includes the store's covered cities. Without
          // the code the picker falls back to a generic "confirm
          // failed" toast and the receiver has no signal about why.
          // Single message regardless of city vs district mismatch —
          // the receiver doesn't need to know the internal
          // granularity. storeCity is included so the toast can
          // render the merchant's primary city as a hint when the
          // detailed deliveryZones aren't available client-side.
          throw new BadRequestException({
            code: 'address_unsupported_for_store',
            storeCity: store.city,
            message:
              'هذا المتجر لا يوصل إلى هذه المنطقة. الرجاء اختيار عنوان داخل نطاق التوصيل المعتمد لدى المتجر.',
          });
        }
      }
    }

    const updated = await this.prisma.gift.update({
      where: { id: giftId },
      data: {
        status: 'address_confirmed' satisfies GiftStatus,
        addressId: chosenAddressId,
        // Stamp once. If the gift is ever revisited later for any reason
        // we keep the original confirmation timestamp.
        confirmedAt: gift.confirmedAt ?? new Date(),
      },
      include: GIFT_INCLUDE,
    });

    void this.notifications.trigger({
      userId: gift.senderId,
      type: NotificationType.GiftAddressConfirmed,
      title: 'تم تأكيد العنوان وجاري التجهيز',
      body: updated.productName,
      // Deep-link to the gift detail so the sender lands on the
      // accepted-state timeline directly.
      link: `/gifts/${gift.id}`,
    });

    // Visibility gate. The receiver is calling this — without the gate
    // they'd see `messageText` + `mediaUrl` (and the anonymous sender's
    // identity, on anonymous gifts) in the response, even though the
    // gift hasn't been delivered yet. The fix is to route every gift
    // return through the same helper as findOne / findSent / findReceived.
    const visible = applyGiftVisibility(
      updated as GiftWithParties,
      viewerUserId,
    );
    // Carry the coverage snapshot fields on the post-confirm
    // response too so the gift-detail page can render the
    // delivered-to-this-zone summary without an extra round-trip.
    const snapshot = await this.loadCoverageSnapshot(
      updated.storeId,
      updated.productId,
    );
    return { ...visible, ...snapshot };
  }

  // Sender cancels a gift before the store has accepted it. Allowed
  // states are `pending_address`, `address_confirmed`, and
  // `default_address_used` — once the gift is `preparing` or beyond,
  // the store has the order and cancellation needs the refund flow
  // (out of scope for this endpoint).
  //
  // Race-safety: we use `updateMany` with a status filter so two
  // concurrent cancel calls (or a cancel racing with the auto-default
  // sweep) only succeed once. A non-zero `count` means we won the race
  // and the row is now cancelled; zero means another writer already
  // moved the row, in which case we return the latest snapshot
  // unchanged (idempotent — same shape as confirmAddress).
  //
  // The receiver gets a "your gift was cancelled" notification with
  // a deep-link to /gifts so they aren't left with a stale "Confirm
  // address" CTA. Notifications swallow errors so a failure here can't
  // roll back the cancellation.
  async cancel(giftId: string, viewerUserId: string) {
    const gift = await this.prisma.gift.findUnique({
      where: { id: giftId },
      include: GIFT_INCLUDE,
    });
    if (!gift) throw new NotFoundException('Gift not found');
    if (gift.senderId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    // Idempotent: already cancelled → return the current snapshot.
    if (gift.status === 'cancelled') {
      return applyGiftVisibility(gift as GiftWithParties, viewerUserId);
    }
    // Past the point of no return — the store has the order.
    const cancellable = new Set([
      'pending_address',
      'address_confirmed',
      'default_address_used',
    ]);
    if (!cancellable.has(gift.status)) {
      throw new BadRequestException('لا يمكن إلغاء الهدية في هذه المرحلة');
    }

    const result = await this.prisma.gift.updateMany({
      where: {
        id: giftId,
        status: { in: Array.from(cancellable) },
      },
      data: { status: 'cancelled' satisfies GiftStatus },
    });
    if (result.count === 0) {
      // Lost the race to another writer (sweep, second cancel call) —
      // re-read and return whatever the row is now.
      const fresh = await this.prisma.gift.findUnique({
        where: { id: giftId },
        include: GIFT_INCLUDE,
      });
      if (!fresh) throw new NotFoundException('Gift not found');
      return applyGiftVisibility(fresh as GiftWithParties, viewerUserId);
    }

    // Notify the receiver. We don't notify the sender — they just
    // performed the action and don't need a self-notification.
    void this.notifications.trigger({
      userId: gift.receiverId,
      type: NotificationType.GiftCancelled,
      title: 'تم إلغاء الهدية',
      body: gift.productName,
      // Deep-link to the gift detail when possible — receiver lands
      // on the cancelled-state card directly instead of bouncing to
      // a list and hunting for it.
      link: `/gifts/${gift.id}`,
    });

    const updated = await this.prisma.gift.findUnique({
      where: { id: giftId },
      include: GIFT_INCLUDE,
    });
    if (!updated) throw new NotFoundException('Gift not found');
    return applyGiftVisibility(updated as GiftWithParties, viewerUserId);
  }

  // Note: the unscoped `findAll()` method (used by the now-removed
  // `GET /gifts` controller route) was deleted. It returned every gift
  // in the system without any visibility filter, which would have
  // leaked messages, media, and addresses across users.

  async findSent(senderId: string, viewerUserId: string) {
    if (senderId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    const list = (await this.prisma.gift.findMany({
      where: { senderId },
      include: GIFT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })) as GiftWithParties[];
    return list.map((g) => applyGiftVisibility(g, senderId));
  }

  async findReceived(receiverId: string, viewerUserId: string) {
    if (receiverId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    const list = (await this.prisma.gift.findMany({
      where: { receiverId },
      include: GIFT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })) as GiftWithParties[];
    return list.map((g) => applyGiftVisibility(g, receiverId));
  }
}

// Privacy-preserving city-match check, duplicated here so the gifts service
// doesn't have to depend on UsersService (which would create a module
// import cycle). The algorithm is identical to UsersService.canDeliverFast
// — keep them in sync. Returns ONLY a boolean; we never log or surface the
// matched address.
async function canDeliverFastInline(
  prisma: PrismaService,
  receiverId: string,
  storeCity: string,
): Promise<boolean> {
  const target = normaliseCity(storeCity);
  if (!target) return false;
  const rows = await prisma.address.findMany({
    where: { userId: receiverId },
    select: { city: true },
  });
  return rows.some((row) => normaliseCity(row.city) === target);
}

function normaliseCity(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
