import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationsService,
  NotificationType,
} from '../notifications/notifications.service';
import { bodyForReceiverGiftUpdate } from '../notifications/notification-privacy';
import type { GiftStatus } from './gift-status';
import { matchAddressToStoreZones } from '../stores/delivery-zones';

// Categories whose products spoil or are time-sensitive, and
// therefore must match the store's configured delivery zones.
// Mirrors the same set used by GiftsService.confirmAddress and
// the frontend's lib/sampleData.FAST_DELIVERY_CATEGORIES.
const FAST_DELIVERY_CATEGORIES: ReadonlySet<string> = new Set([
  'flowers',
  'chocolate',
  'cake',
  'perishable',
]);

// How long a gift is allowed to sit in `pending_address` before we auto-
// flip it onto the receiver's default address.
const AUTO_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// How often the sweep runs. Every 10 minutes is plenty for a 24h window
// — the worst-case lateness is ~10m, well below the user's perception of
// "the day passed".
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Background sweeper that promotes overdue `pending_address` gifts onto
// the receiver's default delivery address. We use a plain setInterval
// instead of pulling in `@nestjs/schedule` because the dependency surface
// for a single 10-minute tick isn't worth it.
//
// Robust against:
//   - missing default addresses (we just leave the gift pending)
//   - multiple replicas (idempotent: writes are conditional on the row
//     still being `pending_address`, so a race between two workers will
//     have one win and the other no-op)
//   - hot-reload in dev (onModuleDestroy clears the interval)
@Injectable()
export class GiftsAutoDefaultService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GiftsAutoDefaultService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // Skip the timer when running tests so Jest doesn't hang on an open
    // handle. Tests can call `runOnce()` directly to exercise the logic.
    if (process.env.NODE_ENV === 'test') return;

    // Kick once on boot so a freshly-restarted server immediately catches
    // anything that fell behind during downtime.
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, SWEEP_INTERVAL_MS);
    // unref so the timer doesn't keep the process alive on shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Public so it can be triggered from a script or test.
  async runOnce(): Promise<{
    promoted: number;
    skipped: number;
    blocked: number;
  }> {
    const cutoff = new Date(Date.now() - AUTO_DEFAULT_TTL_MS);
    const overdue = await this.prisma.gift.findMany({
      where: {
        status: 'pending_address',
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        senderId: true,
        receiverId: true,
        productName: true,
        storeId: true,
        productId: true,
        // Surprise-aware notification bodies need this. Without it
        // the bodyForReceiverGiftUpdate helper can't honour the
        // surprise mask and would leak productName via the
        // GiftAutoFallbackBlocked / GiftDefaultAddressUsed pushes.
        isSurprise: true,
      },
    });

    let promoted = 0;
    let skipped = 0;
    // Coverage-blocked: receiver has saved addresses but none fall
    // inside the merchant's zones. Counted separately so ops can
    // tell "no address configured" apart from "address exists but
    // out of coverage" in the logs.
    let blocked = 0;

    for (const gift of overdue) {
      try {
        // Resolve the merchant store + product context. We need
        // both to decide whether coverage matters — non-fast-
        // delivery products skip the matcher entirely.
        const store = gift.storeId
          ? await this.prisma.store.findUnique({
              where: { id: gift.storeId },
              select: { city: true, deliveryZones: true },
            })
          : null;
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

        // Pull every saved address — default first, then the rest.
        // Privacy: these are the receiver's own rows; we only use
        // them inside this server-side sweep. The sender never
        // sees them; the only side-effect on success is writing
        // the chosen `addressId` onto the Gift, which the merchant
        // dashboard reads.
        const candidates = await this.prisma.address.findMany({
          where: { userId: gift.receiverId },
          select: {
            id: true,
            city: true,
            district: true,
            isDefault: true,
          },
          // Address has no createdAt, but cuid IDs are chronologically
          // ordered prefix-wise — sorting by id approximates "oldest
          // saved first" as a stable tiebreaker after default.
          orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
        });
        if (candidates.length === 0) {
          // Receiver still has no addresses at all — nothing we
          // can do without their input. /profile already nags them
          // via the suspension banner.
          skipped += 1;
          continue;
        }

        // For non-fast-delivery products, fall back to the legacy
        // "use the default" behaviour — coverage doesn't apply,
        // and we keep the existing UX. For fast-delivery, walk the
        // candidates and pick the first that matches merchant
        // coverage. If the gift has no linked store (legacy /
        // sample) we also fall back to the default.
        let chosenId: string | null = null;
        if (!isFastDelivery || !store) {
          chosenId = candidates[0].id;
        } else {
          for (const a of candidates) {
            const match = matchAddressToStoreZones(
              { city: a.city, district: a.district },
              { city: store.city, deliveryZones: store.deliveryZones },
              true,
            );
            if (match.ok) {
              chosenId = a.id;
              break;
            }
          }
        }

        if (!chosenId) {
          // Receiver has saved addresses, but none of them fall
          // inside the merchant's delivery zones. Per the
          // architecture rule, do NOT auto-confirm an unsupported
          // address. Leave the gift pending and ping both sides so
          // someone can act:
          //   - Receiver gets a "your saved addresses don't cover
          //     this merchant — add or pick a different one" nudge
          //     so they know the gift is parked on them.
          //   - Sender gets a heads-up that auto-confirm fell
          //     through, no action needed but they shouldn't be
          //     surprised when the gift sits longer.
          // Privacy: neither notification mentions WHICH address
          // failed or any city/district. Receiver body respects
          // the surprise mask (gift is still pending_address,
          // pre-delivery); sender body always shows the product
          // they themselves chose.
          blocked += 1;
          const giftLink = `/gifts/${gift.id}`;
          void this.notifications.trigger({
            userId: gift.receiverId,
            type: NotificationType.GiftAutoFallbackBlocked,
            title: 'لم نتمكن من تأكيد العنوان تلقائياً',
            body: bodyForReceiverGiftUpdate(
              { isSurprise: gift.isSurprise, status: 'pending_address' },
              gift.productName,
            ),
            link: giftLink,
          });
          void this.notifications.trigger({
            userId: gift.senderId,
            type: NotificationType.GiftAutoFallbackBlocked,
            title: 'هديتك بانتظار اختيار عنوان مدعوم من المتجر',
            body: gift.productName,
            link: giftLink,
          });
          continue;
        }

        // Conditional update: only flip if the row is STILL pending. This
        // is what makes the sweep safe under concurrent runs.
        const result = await this.prisma.gift.updateMany({
          where: { id: gift.id, status: 'pending_address' },
          data: {
            status: 'default_address_used' satisfies GiftStatus,
            addressId: chosenId,
            confirmedAt: new Date(),
          },
        });
        if (result.count === 0) {
          skipped += 1;
          continue;
        }
        promoted += 1;

        // Notify both sides. The receiver's message is more apologetic
        // ("we used a saved address") because they're the one who
        // could have confirmed; the sender's is informational.
        // Receiver body respects the surprise mask — after the
        // sweep, status is `default_address_used` (pre-delivery)
        // so a surprise gift still keeps its product hidden.
        const giftLink = `/gifts/${gift.id}`;
        void this.notifications.trigger({
          userId: gift.receiverId,
          type: NotificationType.GiftDefaultAddressUsed,
          title: 'تم استخدام عنوانك المحفوظ لإرسال الهدية',
          body: bodyForReceiverGiftUpdate(
            { isSurprise: gift.isSurprise, status: 'default_address_used' },
            gift.productName,
          ),
          link: giftLink,
        });
        void this.notifications.trigger({
          userId: gift.senderId,
          type: NotificationType.GiftDefaultAddressUsed,
          title: 'تم استخدام العنوان الافتراضي للتوصيل',
          body: gift.productName,
          link: giftLink,
        });
      } catch (err) {
        // One bad row shouldn't take the whole sweep down.
        this.logger.warn(
          `Auto-default sweep failed for gift ${gift.id}: ${(err as Error).message}`,
        );
        skipped += 1;
      }
    }

    if (promoted > 0 || blocked > 0) {
      this.logger.log(
        `Auto-default sweep: promoted ${promoted}, blocked ${blocked}, skipped ${skipped}`,
      );
    }
    return { promoted, skipped, blocked };
  }
}
