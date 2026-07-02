import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GiftsService } from '../gifts/gifts.service';
import { FinancialLedgerService } from '../financial/financial-ledger.service';
import { buildOrderLedgerEntries } from '../financial/order-ledger';
import { validatePaymentProvider } from './providers';
import { getGateway } from './gateways/registry';

const FORBIDDEN_MSG = 'غير مصرح لك';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private gifts: GiftsService,
    private ledger: FinancialLedgerService,
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

    // Idempotent fast-path: if a previous confirm already finished, return
    // the same snapshot. This catches the common cause of duplicate
    // payments — a network retry after the response was lost. The race
    // between two parallel calls is handled below by a guarded UPDATE.
    if (order.status === 'paid' && order.gift) {
      // Self-heal: if a prior confirm committed the payment but its
      // ledger write failed, back-fill it now (idempotent no-op if the
      // entries already exist).
      await this.ensureLedgerForPaidOrder(order);
      return { order, gift: order.gift };
    }

    if (!validatePaymentProvider(order.country, order.paymentProvider)) {
      throw new BadRequestException('Invalid payment provider for country');
    }

    // Race-safe locking: flip the order from 'pending' → 'processing'
    // BEFORE we touch the gateway. updateMany with a where-status filter
    // is the standard "first writer wins" pattern in Prisma — the second
    // caller's `count` comes back 0 and they bail to the fast-path.
    //
    // Without this guard, a double-clicked Pay button (or a network retry
    // that reached the server twice) could race two gateway charges +
    // two gift creations against the same order. The unique constraint
    // on Order.giftId would then 500 the loser at the linking step,
    // leaving a paid orphan gift behind.
    const lockResult = await this.prisma.order.updateMany({
      where: { id: order.id, status: 'pending' },
      data: { status: 'processing' },
    });
    if (lockResult.count === 0) {
      // Either another caller already moved the order forward, or the
      // status isn't 'pending' (e.g. earlier 'failed'). Re-read and
      // either return the paid snapshot or surface the failed state.
      const refreshed = await this.prisma.order.findUnique({
        where: { id: order.id },
        include: { payment: true, gift: true },
      });
      if (refreshed?.status === 'paid' && refreshed.gift) {
        await this.ensureLedgerForPaidOrder(refreshed);
        return { order: refreshed, gift: refreshed.gift };
      }
      // Order is in some other state (failed / processing without gift);
      // surface a clean error rather than silently retrying.
      throw new BadRequestException('Order is not in a payable state');
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
      // Roll the lock back to 'failed' so retries can't re-enter; record
      // the gateway failure on Payment for the dashboard.
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
    // GiftsService.create returns the Prisma row + visibility flags;
    // the only thing we need here is `id` for the linking update
    // below. Narrowing to `{ id: string }` keeps the lint clean
    // without pulling in the full Gift type from another module.
    //
    // Week 2 — GiftsService.create now returns { gift, replayed }
    // because POST /gifts supports the Idempotency-Key header.
    // PaymentsService is an internal caller that doesn't supply a
    // key (every Order → Gift transition is the operator's intent
    // and the Order row itself is the dedup primitive at that
    // layer), so we get { replayed: false } here and only need
    // the gift's id.
    let gift: { id: string };
    try {
      const created = await this.gifts.create(
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
          // Forward the optional Phase 6.4 occasion-attach. GiftsService.
          // create re-validates it against (senderId, receiverId, owner)
          // so a stale Order.occasionId won't slip through.
          occasionId: order.occasionId ?? undefined,
        },
        viewerUserId,
        // No Idempotency-Key for the internal Order → Gift path.
        null,
      );
      gift = created.gift;
    } catch (err) {
      // Gift creation failed AFTER the gateway charged — record the
      // failure on the order so the user (and ops) can investigate.
      // We don't roll back the gateway charge here; that's the
      // refund-flow's job, which is provider-specific and runs out of
      // band of this request. The buyer sees a clear "payment captured
      // but gift could not be created" error from the rethrown
      // exception below.
      await this.recordFailedPayment(
        order.id,
        order,
        initiated.providerPaymentId,
      );
      throw err;
    }

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

    // Ledger writes run POST-commit (best-effort), not inside the paid
    // transaction — see ensureLedgerForPaidOrder for the rationale.
    await this.ensureLedgerForPaidOrder(updated);

    return { order: updated, gift };
  }

  // Records the append-only financial ledger entries for a PAID order.
  //
  // FAILURE STRATEGY — best-effort; NEVER fails the payment. By the time
  // this runs the gateway has charged, the Gift exists, and the Order is
  // committed as 'paid'. A ledger hiccup is a bookkeeping issue to retry,
  // not a reason to fail a completed sale — so we swallow-and-log loudly.
  // It self-heals: the idempotent fast-paths in confirmMock re-invoke
  // this on the next confirm read, and the (orderId, reasonCode) unique
  // key makes the retry safe. (We deliberately do NOT put these writes
  // inside the paid $transaction: a ledger bug must never be able to roll
  // back — and thereby block — a real payment.)
  //
  // IDEMPOTENCY — two layers: (1) skip entirely if entries already exist
  // for this order; (2) the DB unique key catches any racing writer
  // (P2002 → treated as already-posted).
  private async ensureLedgerForPaidOrder(order: {
    id: string;
    userId: string;
    storeId: string | null;
    productPrice: number;
    serviceFee: number;
    deliveryFee: number;
    totalAmount: number;
    currency: string;
    paymentProvider: string;
    payment?: { id: string } | null;
  }) {
    try {
      const existing = await this.ledger.findByOrder(order.id);
      if (existing.length > 0) return; // already posted — idempotent no-op

      const entries = buildOrderLedgerEntries(order, order.payment?.id ?? null);
      for (const entry of entries) {
        try {
          await this.ledger.record(entry);
        } catch (err) {
          // A racing confirm already wrote this (orderId, reasonCode).
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      this.logger.error(
        `[ledger-failed] order=${order.id} — payment stands; ledger will ` +
          `be retried on the next confirm. error=` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
