import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GiftsService } from '../gifts/gifts.service';
import { validatePaymentProvider, type PaymentProvider } from './providers';
import { getGateway } from './gateways/registry';

const FORBIDDEN_MSG = 'غير مصرح لك';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private gifts: GiftsService,
  ) {}

  async confirmMock(orderId: string, viewerUserId: string) {
    const id = orderId?.trim();
    if (!id) {
      throw new BadRequestException('orderId is required');
    }

    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { payment: true, gift: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }

    // Idempotent: if already paid and we already created the gift, just
    // return the latest snapshot.
    if (order.status === 'paid' && order.gift) {
      return { order, gift: order.gift };
    }

    if (!validatePaymentProvider(order.country, order.paymentProvider)) {
      throw new BadRequestException('Invalid payment provider for country');
    }

    // Run the (currently mocked) gateway for the provider on this order.
    const gateway = getGateway(order.paymentProvider);
    const initiated = await gateway.initiate({
      orderId: order.id,
      amount: order.totalAmount,
      currency: order.currency,
    });
    const result = await gateway.confirm(initiated.providerPaymentId);
    if (result.status !== 'paid') {
      await this.recordFailedPayment(
        order.id,
        order,
        initiated.providerPaymentId,
      );
      throw new BadRequestException('Payment was not authorized');
    }

    // Hand off to the gifts service so all the existing rules apply
    // (self-send guard, default-address guard, anonymous masking,
    // JWT-bound senderId, surprise reveal gate). Every field captured
    // on the Order at /checkout time is forwarded here so the Gift
    // inherits the buyer's full intent.
    const gift = await this.gifts.create(
      {
        receiverUsername: order.receiverUsername,
        productName: order.productName,
        storeName: order.storeName,
        // Order.message is the legacy column name; GiftsService.create
        // accepts both `messageText` (new) and `message` (legacy) for
        // backward compatibility, so we can pass it as-is.
        messageText: order.message ?? undefined,
        isAnonymous: order.isAnonymous,
        // Surprise mode is the receive-side reveal gate (productName +
        // storeName masked until delivery). Carried from Order.
        isSurprise: order.isSurprise,
        // Optional media attachment. mediaType is only meaningful when
        // mediaUrl is set; we forward both as captured.
        mediaUrl: order.mediaUrl ?? undefined,
        mediaType:
          order.mediaType === 'image' || order.mediaType === 'video'
            ? order.mediaType
            : undefined,
        // Forward catalog identifiers so the Gift inherits them. These
        // were captured on the Order at create-time and survive into
        // payment confirmation here.
        productId: order.productId ?? undefined,
        storeId: order.storeId ?? undefined,
      },
      viewerUserId,
    );

    // Persist the payment and link the gift to the order in a single
    // transaction so we never end up with a paid order without a gift.
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.payment.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          provider: order.paymentProvider,
          providerPaymentId: initiated.providerPaymentId,
          amount: order.totalAmount,
          currency: order.currency,
          status: 'paid',
        },
        update: {
          provider: order.paymentProvider,
          providerPaymentId: initiated.providerPaymentId,
          status: 'paid',
        },
      });

      return tx.order.update({
        where: { id: order.id },
        data: { status: 'paid', giftId: gift.id },
        include: { payment: true, gift: true },
      });
    });

    return { order: updated, gift };
  }

  private async recordFailedPayment(
    orderId: string,
    order: { totalAmount: number; currency: string; paymentProvider: string },
    providerPaymentId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.upsert({
        where: { orderId },
        create: {
          orderId,
          provider: order.paymentProvider,
          providerPaymentId,
          amount: order.totalAmount,
          currency: order.currency,
          status: 'failed',
        },
        update: {
          providerPaymentId,
          status: 'failed',
        },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'failed' },
      });
    });
  }
}
