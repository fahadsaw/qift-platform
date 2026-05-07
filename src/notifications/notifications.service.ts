import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

// Discriminator strings used by the gift-flow triggers. Kept as a const
// object so the rest of the codebase imports a typo-proof symbol instead
// of stringly-typed values.
export const NotificationType = {
  GiftReceived: 'gift.received',
  GiftConfirmAddress: 'gift.confirm_address',
  GiftAddressConfirmed: 'gift.address_confirmed',
  GiftDefaultAddressUsed: 'gift.default_address_used',
  GiftPreparing: 'gift.preparing',
  GiftShipped: 'gift.shipped',
  GiftDelivered: 'gift.delivered',
  // Sender or admin cancelled the gift before the store accepted it.
  // Receiver gets a heads-up so they don't keep waiting on a phantom
  // "Confirm address" CTA.
  GiftCancelled: 'gift.cancelled',
  // Kept as alias so existing notification rows render correctly.
  GiftReadyForDelivery: 'gift.address_confirmed',
  // Receiver: someone tried to send you a gift but you don't yet have a
  // default address. Fires on every blocked POST /gifts.
  GiftAttemptedNoAddress: 'gift.attempted_no_address',
  // Sender: a previous failed attempt is now retryable because the
  // receiver finally set a default address. Fires once per attempt
  // (notifiedAt is stamped to dedupe).
  GiftAddressReadyForRetry: 'gift.address_ready_for_retry',
} as const;
export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

export type CreateNotificationInput = {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
};

const FORBIDDEN_MSG = 'غير مصرح لك';

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  // Internal trigger used by GiftsService + StoreService. We deliberately
  // swallow errors so a failed notification write can never block the
  // underlying gift mutation — the user-visible flow is more important
  // than the bell.
  //
  // Side effect: every successful in-app create also fans out to the
  // user's registered push subscriptions. Push is fire-and-forget — we
  // don't await it, and PushService.sendToUser swallows internal errors,
  // so a push outage / missing VAPID config never ripples back into the
  // calling gift / payment / status flow.
  async trigger(input: CreateNotificationInput) {
    let row: Awaited<ReturnType<typeof this.prisma.notification.create>> | null;
    try {
      row = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          link: input.link ?? null,
        },
      });
    } catch {
      return null;
    }
    void this.push.sendToUser(input.userId, {
      title: input.title,
      body: input.body ?? null,
      url: input.link ?? null,
      type: input.type,
    });
    return row;
  }

  // Public-via-controller create. Same as trigger() but lets exceptions
  // propagate so the caller sees real validation errors, and pins the
  // userId to the authenticated viewer so a client can't queue a
  // notification into someone else's inbox.
  create(viewerUserId: string, body: Omit<CreateNotificationInput, 'userId'>) {
    return this.prisma.notification.create({
      data: {
        userId: viewerUserId,
        type: body.type,
        title: body.title,
        body: body.body ?? null,
        link: body.link ?? null,
      },
    });
  }

  // Latest-first feed for the bell + /notifications page. Capped at 100 so
  // a runaway producer can't ship megabytes of payload to a phone.
  list(viewerUserId: string) {
    return this.prisma.notification.findMany({
      where: { userId: viewerUserId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // Used by the bell badge. Index on (userId, isRead) makes this cheap.
  unreadCount(viewerUserId: string) {
    return this.prisma.notification.count({
      where: { userId: viewerUserId, isRead: false },
    });
  }

  async markRead(viewerUserId: string, id: string) {
    const existing = await this.prisma.notification.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    if (existing.userId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllRead(viewerUserId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId: viewerUserId, isRead: false },
      data: { isRead: true },
    });
    return { ok: true, updated: result.count };
  }
}
