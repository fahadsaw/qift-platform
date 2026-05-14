// Phase 7.1 — NotificationOrchestrator.
//
// The single entry point notifications now route through. Composes:
//   - notification-categories (the truth table)
//   - notification-quiet-hours (pure helper)
//   - notification-budget (pure engine)
//   - Prisma (for the user's preferences + recent-count reads)
//   - PushService (for the real-time push fanout)
//
// Decision flow on enqueue():
//   1. Resolve the category from the legacy notification type.
//   2. Read the user's NotificationPreferences (cheap; 1 indexed
//      lookup). Lazy-create on first read.
//   3. If mandatory category → always send. Skip the engine.
//   4. Else:
//      a. Check per-category opt-out → 'suppress' if true.
//      b. Count rows in this category for the last 24h + 7d.
//      c. Check quiet hours.
//      d. Call evaluateBudget() — get a BudgetDecision.
//   5. Act on the decision:
//      - 'send_realtime': write Notification row WITH
//        pushDeliveredAt = now, fanout push.
//      - 'queue_digest': write Notification row WITH
//        pushDeliveredAt = null. Future digest worker picks it up.
//      - 'suppress': no row written.
//
// What is INTENTIONALLY not built here:
//   - The digest worker itself (Phase 7.2). The orchestrator only
//     marks rows; nothing fires the batch yet.
//   - The reminder worker that calls this for OccasionReminder
//     rows. The data layer for that lives in Phase 6; the worker
//     stays disabled via QIFT_OCCASION_REMINDER_FIRING_ENABLED.
//   - Email / SMS provider integration. The orchestrator handles
//     in-app + push for now; email / SMS channels resolve to a
//     no-op until provider adapters land (see
//     project_external_integrations_architecture.md).

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import {
  type NotificationCategory,
  categoryForType,
  descriptorFor,
  isMandatory,
} from './notification-categories';
import { evaluateBudget, type BudgetDecision } from './notification-budget';
import { isPushDeliveryEnabled } from './notification-feature-flags';
import { inQuietHours } from './notification-quiet-hours';

// ── Inputs ──────────────────────────────────────────────────────

export type EnqueueInput = {
  userId: string;
  // Legacy type discriminator (e.g. 'gift.received'). Resolves to
  // a NotificationCategory via categoryForType().
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  // Optional explicit category override. Used by future callers
  // (e.g. an occasion-reminder worker) that already know their
  // category and don't want to round-trip through categoryForType.
  category?: NotificationCategory;
  // Test seam — allows unit specs to pin "now" without freezing
  // the system clock.
  now?: Date;
};

// ── Result (audit-shaped) ───────────────────────────────────────

export type EnqueueResult =
  | {
      kind: 'sent';
      notificationId: string;
      category: NotificationCategory;
      pushed: boolean;
    }
  | {
      kind: 'queued_for_digest';
      notificationId: string;
      category: NotificationCategory;
      reason: string;
    }
  | { kind: 'suppressed'; category: NotificationCategory; reason: string };

// ── Service ─────────────────────────────────────────────────────

@Injectable()
export class NotificationOrchestrator {
  private readonly logger = new Logger(NotificationOrchestrator.name);

  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const now = input.now ?? new Date();
    const category = input.category ?? categoryForType(input.type);
    const descriptor = descriptorFor(category);
    const priority = descriptor.priority;

    // Mandatory categories bypass every gate. We still record the
    // category + priority on the row for audit / future telemetry.
    if (isMandatory(category)) {
      const row = await this.writeNotificationRow({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
        category,
        priority,
        pushDeliveredAt: now,
      });
      if (!row) {
        return { kind: 'suppressed', category, reason: 'db_error' };
      }
      // Fire-and-forget push. We don't await — a push outage must
      // not block the underlying mutation.
      void this.firePush(input);
      return {
        kind: 'sent',
        notificationId: row.id,
        category,
        pushed: true,
      };
    }

    // Optional categories: consult preferences + counts + budget.
    const prefs = await this.loadPreferences(input.userId);
    const optedOut = readOptOut(prefs.categoryOptOuts, category);

    const decision = await this.makeDecision({
      userId: input.userId,
      category,
      descriptor,
      now,
      optedOut,
      prefs,
    });

    if (decision.kind === 'suppress') {
      return { kind: 'suppressed', category, reason: decision.reason };
    }

    if (decision.kind === 'queue_digest') {
      const row = await this.writeNotificationRow({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
        category,
        priority,
        // pushDeliveredAt stays null — future digest worker picks
        // this up via the (userId, pushDeliveredAt IS NULL) index.
        pushDeliveredAt: null,
      });
      if (!row) {
        return { kind: 'suppressed', category, reason: 'db_error' };
      }
      return {
        kind: 'queued_for_digest',
        notificationId: row.id,
        category,
        reason: decision.reason,
      };
    }

    // decision.kind === 'send_realtime'
    const row = await this.writeNotificationRow({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link,
      category,
      priority,
      pushDeliveredAt: now,
    });
    if (!row) {
      return { kind: 'suppressed', category, reason: 'db_error' };
    }
    void this.firePush(input);
    return {
      kind: 'sent',
      notificationId: row.id,
      category,
      pushed: true,
    };
  }

  // ── Internal helpers ──────────────────────────────────────────

  private async writeNotificationRow(args: {
    userId: string;
    type: string;
    title: string;
    body?: string | null;
    link?: string | null;
    category: NotificationCategory;
    priority: string;
    pushDeliveredAt: Date | null;
  }) {
    try {
      return await this.prisma.notification.create({
        data: {
          userId: args.userId,
          type: args.type,
          title: args.title,
          body: args.body ?? null,
          link: args.link ?? null,
          category: args.category,
          priority: args.priority,
          pushDeliveredAt: args.pushDeliveredAt,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[notif-orchestrator] failed to write Notification row userId=${args.userId} category=${args.category} err=${(err as Error).message}`,
      );
      return null;
    }
  }

  private firePush(input: EnqueueInput): void {
    // Global push kill switch — emergency stop independent of
    // per-user preferences or category eligibility. When false
    // (Phase 7.2 default), the in-app Notification row still
    // writes (the always-on inbox) but no push fires. Used to
    // disable push during incidents without changing app code.
    if (!isPushDeliveryEnabled()) return;
    void this.push.sendToUser(input.userId, {
      title: input.title,
      body: input.body ?? null,
      url: input.link ?? null,
      type: input.type,
    });
  }

  // Lazy-load preferences. Default-row semantics: a missing row is
  // equivalent to "all defaults" (no quiet hours, no opt-outs,
  // digest enabled). We DON'T auto-create the row here — the
  // PATCH /users/me/notification-preferences endpoint is the
  // owner of writes. Reads in the orchestrator just fill defaults
  // when nothing is stored.
  private async loadPreferences(userId: string): Promise<{
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    quietHoursTimezone: string;
    categoryOptOuts: Record<string, boolean>;
    digestEnabled: boolean;
  }> {
    const row = await this.prisma.notificationPreferences.findUnique({
      where: { userId },
    });
    if (!row) {
      return {
        quietHoursStart: null,
        quietHoursEnd: null,
        quietHoursTimezone: 'Asia/Riyadh',
        categoryOptOuts: {},
        digestEnabled: true,
      };
    }
    return {
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
      quietHoursTimezone: row.quietHoursTimezone,
      categoryOptOuts: parseOptOuts(row.categoryOptOuts),
      digestEnabled: row.digestEnabled,
    };
  }

  // Compose the decision. Runs the count queries + quiet-hours
  // check, then defers to evaluateBudget().
  private async makeDecision(args: {
    userId: string;
    category: NotificationCategory;
    descriptor: ReturnType<typeof descriptorFor>;
    now: Date;
    optedOut: boolean;
    prefs: {
      quietHoursStart: string | null;
      quietHoursEnd: string | null;
      quietHoursTimezone: string;
      digestEnabled: boolean;
    };
  }): Promise<BudgetDecision> {
    const { userId, category, descriptor, now, optedOut, prefs } = args;

    // Counts. Both queries hit the composite index
    // (userId, category, createdAt). One round-trip via $transaction.
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [dailyCount, weeklyCount] = await this.prisma.$transaction([
      this.prisma.notification.count({
        where: { userId, category, createdAt: { gte: dayAgo } },
      }),
      this.prisma.notification.count({
        where: { userId, category, createdAt: { gte: weekAgo } },
      }),
    ]);

    const inQH = inQuietHours(
      {
        start: prefs.quietHoursStart,
        end: prefs.quietHoursEnd,
        timezone: prefs.quietHoursTimezone,
      },
      now,
    );

    return evaluateBudget({
      category,
      descriptor,
      dailyCount,
      weeklyCount,
      optedOut,
      inQuietHours: inQH,
      digestEnabled: prefs.digestEnabled,
    });
  }
}

// ── JSON helpers ────────────────────────────────────────────────

// Coerce the JSON column into a string → boolean dict. Anything
// unrecognised collapses to "{}" (default-allow) — corrupted
// data must NOT accidentally silence a user.
function parseOptOuts(raw: Prisma.JsonValue): Record<string, boolean> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function readOptOut(
  dict: Record<string, boolean>,
  category: NotificationCategory,
): boolean {
  // Default-allow: a missing key means opted IN. Only an
  // explicit `true` opts the user out.
  return dict[category] === true;
}
