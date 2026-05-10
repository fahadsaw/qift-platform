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
import { validatePaymentProvider } from '../payments/providers';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { validateGiftMedia } from '../gifts/gift-visibility';
import { getDefaultAddressForUser } from '../addresses/default-address.helper';

// `userId` is intentionally not in the input — it's always taken from the
// JWT viewer in the controller layer.
export type CreateOrderInput = {
  receiverUsername?: string;
  productName?: string;
  storeName?: string;
  productPrice?: number;
  serviceFee?: number;
  deliveryFee?: number;
  totalAmount?: number;
  currency?: string;
  country?: string;
  paymentProvider?: string;
  message?: string;
  isAnonymous?: boolean;
  // Sender's "surprise mode". Carried through Order → Payment confirm →
  // Gift create so the surprise reveal-gate setting survives the
  // payment hop. Default false matches the Gift schema default.
  isSurprise?: boolean;
  // Optional media attachment. Persisted on Order so the value survives
  // payment confirmation; PaymentsService forwards both fields to
  // GiftsService.create when the order goes paid. Same privacy rules
  // as the Gift columns (stripped from receiver until delivery).
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  // Fast-delivery context. If `isFastDelivery` is true we require the
  // receiver to have *any* address in `storeCity`; otherwise the field is
  // ignored. Both fields originate from the catalog/frontend and are
  // re-validated server-side here so we can't be bypassed by editing the
  // client.
  isFastDelivery?: boolean;
  storeCity?: string;
  // Optional FK to a real catalog product. When supplied we run the
  // stock check; when omitted (legacy/sample-product flows) the check
  // is skipped so the demo paths keep working.
  productId?: string;
  storeId?: string;
};

const FORBIDDEN_MSG = 'غير مصرح لك';

const ORDER_INCLUDE = {
  payment: true,
  gift: true,
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private users: UsersService,
    private products: ProductsService,
  ) {}

  async create(body: CreateOrderInput, viewerUserId: string) {
    const receiverUsername = body.receiverUsername?.trim().toLowerCase();
    const productName = body.productName?.trim();
    const storeName = body.storeName?.trim();
    const currency = body.currency?.trim().toUpperCase();
    const country = body.country?.trim().toUpperCase();
    const paymentProvider = body.paymentProvider?.trim();
    const message = body.message?.trim() || null;
    const isAnonymous = body.isAnonymous === true;
    const isSurprise = body.isSurprise === true;
    // Validate the (mediaUrl, mediaType) pair with the SAME helper that
    // POST /gifts uses. A URL without a valid type throws — keeps the
    // server in one canonical place for media validation.
    const { mediaUrl, mediaType } = validateGiftMedia(
      body.mediaUrl,
      body.mediaType,
    );

    if (
      !receiverUsername ||
      !productName ||
      !storeName ||
      !currency ||
      !country ||
      !paymentProvider
    ) {
      throw new BadRequestException(
        'receiverUsername, productName, storeName, currency, country and paymentProvider are required',
      );
    }

    const productPrice = numberOr(body.productPrice);
    const serviceFee = numberOr(body.serviceFee);
    const deliveryFee = numberOr(body.deliveryFee);
    const totalAmount = numberOr(body.totalAmount);

    if (
      productPrice == null ||
      serviceFee == null ||
      deliveryFee == null ||
      totalAmount == null
    ) {
      throw new BadRequestException(
        'productPrice, serviceFee, deliveryFee and totalAmount must be numbers',
      );
    }

    if (!validatePaymentProvider(country, paymentProvider)) {
      throw new BadRequestException(
        `Payment provider ${paymentProvider} is not allowed for country ${country}`,
      );
    }

    // Self-send guard mirrors the gifts service so we never even create an
    // order pointing back at the buyer.
    const sender = await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { qiftUsername: true },
    });
    if (!sender) throw new NotFoundException('Sender not found');
    if (sender.qiftUsername.toLowerCase() === receiverUsername) {
      throw new BadRequestException('لا يمكنك إرسال هدية لنفسك');
    }

    // Confirm the receiver actually exists AND has a default delivery address
    // before we charge anyone. This is the same hard guard the gifts service
    // applies; we duplicate it here so we never even open a payment intent
    // against a suspended/incomplete receiver account.
    //
    // Both the existence query and the default-address resolver run
    // through the canonical helpers so the pre-flight /users/check
    // endpoint and this gate cannot disagree about a recipient's
    // readiness.
    const receiver = await this.prisma.user.findFirst({
      where: { qiftUsername: receiverUsername, deletedAt: null },
      select: { id: true },
    });
    if (!receiver) throw new NotFoundException('Receiver not found');
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
        `[gift-flow] orders.create receiverId=${receiver.id} username="${receiverUsername}" addressCount=${totalCount} defaultCount=${defaultCount} resolvedDefaultId=${defaultAddress?.id ?? null}`,
      );
    }
    if (!defaultAddress) {
      // Hard rule (intentional): we refuse to charge the buyer when the
      // recipient has no default delivery address. Without one, the
      // store order can sit indefinitely waiting on the recipient,
      // creating refund problems for the buyer and operational issues
      // for the merchant. Keep this gate strict.
      //
      // Same shape as the gifts.service equivalent: 422 with a stable
      // machine-readable `code` so the frontend doesn't have to match
      // localized strings to identify the failure.
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: 'recipient_no_default_address',
          message:
            'المستلم لم يحدد عنوانًا افتراضيًا بعد، لذلك لا يمكن إرسال الهدية له حاليًا.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Fast-delivery gate (flowers / chocolate / cake / perishables): the
    // receiver MUST have an address in the same city as the store. We re-
    // run the check server-side using the privacy-preserving helper so a
    // tampered client can't bypass the /send page warning.
    //
    // The error message is intentionally generic — we never reveal which
    // cities the receiver does/doesn't have addresses in.
    if (body.isFastDelivery === true) {
      const storeCity = body.storeCity?.trim();
      if (!storeCity) {
        throw new BadRequestException(
          'storeCity is required for fast-delivery products',
        );
      }
      const ok = await this.users.canDeliverFast(receiver.id, storeCity);
      if (!ok) {
        throw new BadRequestException('لا يمكن التوصيل لهذا المستخدم');
      }
    }

    // Out-of-stock guard. Only runs when a real catalog productId was
    // supplied — sample-product flows pass nothing and skip the check.
    // Throws BadRequestException('المنتج غير متوفر حاليًا') if the product
    // is unavailable or out of stock.
    //
    // We capture the return value because checkAvailability also exposes
    // the product's owning storeId — used as an authoritative server-
    // side fallback below when the buyer's checkout payload didn't
    // include storeId. This is the fix for the "merchant doesn't see
    // the order" bug: a tampered or stale frontend that drops
    // storeIdRef from the URL no longer creates an unlinked order, as
    // long as productId resolves to a real catalog row.
    const productInfo = await this.products.checkAvailability(body.productId);

    // Resolve storeId. Preference order:
    //   1. body.storeId — what the frontend sent (storeIdRef).
    //   2. product.storeId — derived from the catalog row when (1) is
    //      missing. The product owns a storeId by schema (NOT NULL on
    //      Product.storeId), so this is the authoritative answer for
    //      any real catalog purchase.
    //   3. null — the legacy / sample-product path. Order is created
    //      unlinked and won't appear in any merchant dashboard. That's
    //      intentional for the demo catalog (no merchant owns sample
    //      products) but a console.warn-equivalent metric would help
    //      flag accidental drops in production.
    const storeIdFromBody = body.storeId?.trim() || null;
    const storeIdFromProduct = productInfo?.storeId ?? null;
    const resolvedStoreId = storeIdFromBody ?? storeIdFromProduct;

    // Order-flow debug logging. Off by default (production) and
    // turned on by ORDER_FLOW_DEBUG=1 on the API process. Logs
    // exactly the linkage decisions that determine whether the
    // merchant will see this order:
    //   - what the buyer's payload sent
    //   - what the catalog says the product's store is
    //   - which one we picked
    // Privacy-safe: only ids + flags, no PII / message / address.
    if (process.env.ORDER_FLOW_DEBUG === '1') {
      this.logger.log(
        `[order-flow] orders.create viewerUserId=${viewerUserId} ` +
          `bodyProductId=${body.productId ?? 'null'} ` +
          `bodyStoreId=${storeIdFromBody ?? 'null'} ` +
          `productStoreId=${storeIdFromProduct ?? 'null'} ` +
          `resolvedStoreId=${resolvedStoreId ?? 'null'} ` +
          `linked=${resolvedStoreId ? 'YES' : 'NO'}`,
      );
    }

    const created = await this.prisma.order.create({
      data: {
        userId: viewerUserId,
        receiverUsername,
        productName,
        storeName,
        // Persist catalog identifiers so PaymentsService can pass them
        // through to GiftsService.create when the payment confirms.
        productId: body.productId?.trim() || null,
        storeId: resolvedStoreId,
        productPrice,
        serviceFee,
        deliveryFee,
        totalAmount,
        currency,
        country,
        paymentProvider: paymentProvider,
        message,
        mediaUrl,
        mediaType,
        isSurprise,
        isAnonymous,
        status: 'pending',
      },
      include: ORDER_INCLUDE,
    });

    if (process.env.ORDER_FLOW_DEBUG === '1') {
      this.logger.log(
        `[order-flow] orders.create persisted orderId=${created.id} ` +
          `productId=${created.productId ?? 'null'} ` +
          `storeId=${created.storeId ?? 'null'}`,
      );
    }

    return created;
  }

  async findOne(id: string, viewerUserId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return order;
  }
}

function numberOr(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
