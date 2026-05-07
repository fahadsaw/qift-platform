import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  validatePaymentProvider,
  type PaymentProvider,
} from '../payments/providers';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { validateGiftMedia } from '../gifts/gift-visibility';

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
    const receiver = await this.prisma.user.findUnique({
      where: { qiftUsername: receiverUsername },
      select: {
        id: true,
        addresses: {
          where: { isDefault: true },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!receiver) throw new NotFoundException('Receiver not found');
    if (receiver.addresses.length === 0) {
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
    await this.products.checkAvailability(body.productId);

    return this.prisma.order.create({
      data: {
        userId: viewerUserId,
        receiverUsername,
        productName,
        storeName,
        // Persist catalog identifiers so PaymentsService can pass them
        // through to GiftsService.create when the payment confirms.
        productId: body.productId?.trim() || null,
        storeId: body.storeId?.trim() || null,
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
