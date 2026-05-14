import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';

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
  // Receiver: 24h elapsed and Qift tried to auto-confirm against
  // your default — but none of your saved addresses fall inside
  // the merchant's delivery zones. Add or pick a covered address,
  // or the gift will stay blocked.
  GiftAutoFallbackBlocked: 'gift.auto_fallback_blocked',
  // Owner of a published GiftPost: someone appreciated your gifting
  // moment. Aggregate-only — body NEVER names the appreciator
  // (privacy + no engagement-farming surface; see
  // `project_interaction_philosophy`). Throttled to at most one
  // notification per (post, owner) per 24h so a burst of
  // appreciations doesn't generate a burst of pings.
  GiftPostAppreciated: 'gift_post.appreciated',
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
    private orchestrator: NotificationOrchestrator,
  ) {}

  // Internal trigger used by GiftsService + StoreService + every
  // gift-flow notification site. Phase 7.1 routes this through the
  // NotificationOrchestrator so:
  //   - category-aware budgets apply automatically (per-user daily
  //     / weekly caps; mandatory categories bypass)
  //   - quiet hours defer alert channels to digest
  //   - per-user opt-outs are honored (mandatory categories bypass)
  //
  // The wire shape of this method is unchanged — callers still pass
  // { userId, type, title, body?, link? } and we return the
  // Notification row (or null on suppression / DB error). Existing
  // call sites need NO changes.
  //
  // Privacy invariant (enforced by the orchestrator's category
  // resolution): the `body` field never carries hidden sender
  // identity, recipient address, private occasion content, or any
  // similar sensitive payload. Callers must keep their bodies
  // generic — the architecture relies on it.
  async trigger(input: CreateNotificationInput) {
    const result = await this.orchestrator.enqueue({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    });
    if (result.kind === 'suppressed') {
      // Suppression is silent to the caller — no log, no row, no
      // throw. The orchestrator already records the decision
      // reason internally; surfacing it here would leak the
      // user's private opt-out to the gift flow.
      return null;
    }
    // For both 'sent' and 'queued_for_digest' the Notification row
    // exists. The gift flow's caller treats both identically — the
    // bell will render the row whenever the user opens the app.
    return this.prisma.notification.findUnique({
      where: { id: result.notificationId },
    });
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
