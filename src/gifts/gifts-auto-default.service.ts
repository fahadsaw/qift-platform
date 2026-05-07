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
import type { GiftStatus } from './gift-status';

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
  async runOnce(): Promise<{ promoted: number; skipped: number }> {
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
      },
    });

    let promoted = 0;
    let skipped = 0;

    for (const gift of overdue) {
      try {
        // Look up the receiver's default address now (not at gift create
        // time) so we honour any address changes they made in the
        // meantime.
        const def = await this.prisma.address.findFirst({
          where: { userId: gift.receiverId, isDefault: true },
          select: { id: true },
        });
        if (!def) {
          // Receiver still has no default address — nothing we can do
          // without their input, so leave it pending. The /profile
          // suspension banner already nags them.
          skipped += 1;
          continue;
        }

        // Conditional update: only flip if the row is STILL pending. This
        // is what makes the sweep safe under concurrent runs.
        const result = await this.prisma.gift.updateMany({
          where: { id: gift.id, status: 'pending_address' },
          data: {
            status: 'default_address_used' satisfies GiftStatus,
            addressId: def.id,
            confirmedAt: new Date(),
          },
        });
        if (result.count === 0) {
          skipped += 1;
          continue;
        }
        promoted += 1;

        // Notify both sides. The receiver's message is more apologetic
        // ("we used your default") because they're the one who could have
        // confirmed; the sender's is informational.
        // Deep-link both notifications to the specific gift so the
        // recipient lands on the timeline (already-confirmed state)
        // and the sender lands on the same row from their inbox.
        const giftLink = `/gifts/${gift.id}`;
        void this.notifications.trigger({
          userId: gift.receiverId,
          type: NotificationType.GiftDefaultAddressUsed,
          title: 'تم استخدام العنوان الافتراضي لإرسال الهدية',
          body: gift.productName,
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

    if (promoted > 0) {
      this.logger.log(
        `Auto-default sweep: promoted ${promoted}, skipped ${skipped}`,
      );
    }
    return { promoted, skipped };
  }
}
