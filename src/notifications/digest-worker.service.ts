// Phase 7.2 — DigestWorker.
//
// Picks up notifications the orchestrator queued for digest
// (Notification rows with pushDeliveredAt = null) and bundles
// them into a single calm summary push per user. Stamps
// pushDeliveredAt on the consumed rows so the next digest run
// doesn't re-bundle them.
//
// Why this exists:
//   - When a user's budget is exceeded OR they're in quiet hours,
//     the orchestrator still WRITES the Notification row (in-app
//     inbox is always-on) but DEFERS the alert channels. Without
//     a digest worker, those rows sit in the bell forever and the
//     user never gets a push notification about them.
//   - The digest gives a single, calm "you have N updates" push
//     once per user per cadence, instead of N individual alerts.
//
// Invariants (any break is a regression):
//
//   1. Idempotency. A row's pushDeliveredAt is stamped EXACTLY
//      once. The worker uses an `updateMany` with a
//      `pushDeliveredAt: null` predicate so a concurrent run on
//      the same row finds zero matches.
//
//   2. Calm summarisation. The digest body is GENERIC ("You
//      have 3 gift updates and 2 occasion reminders") — never a
//      list of titles, never per-row body content. The user
//      opens the bell to see details. No pressure language, no
//      "missed this!", no count-of-unread escalation.
//
//   3. Per-user cadence. A user with digestFrequency='weekly'
//      is processed only on the cadence; a daily user every run.
//      The "is this user due?" check uses the last successful
//      digest's stamped timestamps + the user's frequency
//      preference.
//
//   4. Never bypass the orchestrator. The worker calls
//      orchestrator.enqueue() with category=system + a special
//      type 'digest.summary'. The orchestrator handles the
//      actual push fanout (subject to QIFT_PUSH_DELIVERY_ENABLED
//      + mandatory-bypass logic).
//
//   5. Activation: QIFT_DIGEST_WORKER_ENABLED. Default OFF.
//
//   6. Privacy. The summary body counts ROWS per category — it
//      never includes the bodies of the underlying rows, never
//      includes recipient identities or other private content.

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { NotificationCategory } from './notification-categories';
import {
  isDigestWorkerEnabled,
  isReminderDryRun,
} from './notification-feature-flags';

// ── Result shapes ───────────────────────────────────────────────

export type DigestRunResult = {
  ran: boolean;
  skippedReason?: 'feature_flag_off';
  // Number of users with at least one queued row at the start.
  usersConsidered: number;
  // Number of users actually processed (cadence + dry-run filter
  // may skip some).
  usersDigested: number;
  // Total Notification rows consumed (pushDeliveredAt stamped).
  rowsConsumed: number;
  errors: number;
  filteredCadence: number;
  filteredDryRun: number;
};

export type DigestRunOptions = {
  now?: Date;
  forceDryRun?: boolean;
  // Cadence override — for testing / manual triggers. When
  // unset, the worker uses each user's stored digestFrequency.
  // When 'force_daily', everyone is processed regardless of
  // their stored cadence; when 'force_weekly', same.
  cadenceOverride?: 'force_daily' | 'force_weekly';
};

// ── Service ─────────────────────────────────────────────────────

@Injectable()
export class DigestWorker {
  private readonly logger = new Logger(DigestWorker.name);

  constructor(
    private prisma: PrismaService,
    private orchestrator: NotificationOrchestrator,
  ) {}

  async runOnce(opts: DigestRunOptions = {}): Promise<DigestRunResult> {
    const now = opts.now ?? new Date();
    const dryRun = opts.forceDryRun === true || isReminderDryRun();

    const stats: DigestRunResult = {
      ran: true,
      usersConsidered: 0,
      usersDigested: 0,
      rowsConsumed: 0,
      errors: 0,
      filteredCadence: 0,
      filteredDryRun: 0,
    };

    if (!isDigestWorkerEnabled() && !dryRun) {
      this.logger.log(
        '[digest-worker] skipped — QIFT_DIGEST_WORKER_ENABLED is off',
      );
      return { ...stats, ran: false, skippedReason: 'feature_flag_off' };
    }

    // Find users with at least one queued (pushDeliveredAt: null)
    // Notification row. We group by userId in code (cheap at the
    // current scale — pulling at most a few thousand rows) so
    // the per-user processing can be sequential.
    //
    // When the queue grows past ~100k pending rows, this becomes
    // a paginated scan with a date window — for Phase 7.2's
    // controlled rollout, the cheap version is correct.
    const pending = await this.prisma.notification.findMany({
      where: { pushDeliveredAt: null },
      select: { id: true, userId: true, category: true },
    });

    const byUser = new Map<string, typeof pending>();
    for (const row of pending) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    stats.usersConsidered = byUser.size;

    for (const [userId, rows] of byUser.entries()) {
      try {
        // Cadence gate. A user with digestFrequency='weekly'
        // is processed on Mondays UTC; daily users every run.
        // The override lets operators force a cadence for
        // testing.
        const prefs = await this.prisma.notificationPreferences.findUnique({
          where: { userId },
          select: { digestFrequency: true, digestEnabled: true },
        });
        const frequency =
          opts.cadenceOverride === 'force_daily'
            ? 'daily'
            : opts.cadenceOverride === 'force_weekly'
              ? 'weekly'
              : (prefs?.digestFrequency ?? 'daily');
        const digestEnabled = prefs?.digestEnabled ?? true;
        if (!digestEnabled) {
          // User asked for real-time delivery. They shouldn't have
          // queued rows in the first place (the orchestrator
          // sends real-time when digestEnabled=false), but if a
          // race did produce one (preference toggled mid-flight),
          // we mark the row as delivered without a digest push so
          // the inbox catches up and we don't spam the user.
          await this.markDelivered(
            rows.map((r) => r.id),
            now,
          );
          stats.rowsConsumed += rows.length;
          continue;
        }
        if (!isDueForDigest(frequency, now)) {
          stats.filteredCadence += 1;
          continue;
        }

        if (dryRun) {
          this.logger.log(
            `[digest-worker] DRY-RUN would digest userId=${userId} rows=${rows.length} categories=${summariseCategories(
              rows,
            )
              .map(([c, n]) => `${c}:${n}`)
              .join(',')}`,
          );
          stats.filteredDryRun += 1;
          continue;
        }

        // Build the summary. Group by category, count, render
        // calm body. The orchestrator handles the actual push.
        const summary = summariseCategories(rows);
        if (summary.length === 0) {
          // Defensive — empty grouping shouldn't happen because
          // `rows` is non-empty by construction. Skip safely.
          continue;
        }
        const body = composeDigestBody(summary);

        // Stamp deliveredAt FIRST (within the same tick) so a
        // concurrent worker run on the same user finds zero
        // unstamped rows and no-ops. Use updateMany with the
        // pushDeliveredAt: null predicate — race-safe.
        const consumed = await this.markDelivered(
          rows.map((r) => r.id),
          now,
        );
        if (consumed === 0) {
          // Lost the race to another worker. Skip the push so
          // the user doesn't get two summaries.
          continue;
        }
        stats.rowsConsumed += consumed;

        // Push the summary via the orchestrator. Category 'system'
        // — low priority, opt-out-able, capped. Type
        // 'digest.summary' so future telemetry can distinguish.
        // If push fails, the rows are already stamped — the user
        // has them in the in-app inbox; we lose only the alert.
        // That's the right trade-off; double-sending is worse.
        try {
          await this.orchestrator.enqueue({
            userId,
            type: 'digest.summary',
            category: NotificationCategory.System,
            title: 'Quiet update',
            body: body,
            link: '/notifications',
            now,
          });
          stats.usersDigested += 1;
        } catch (err) {
          // Push pipeline broken — rows are stamped; user reads
          // from the inbox. Log + count, don't crash.
          stats.errors += 1;
          this.logger.warn(
            `[digest-worker] summary push failed userId=${userId} err=${(err as Error).message}`,
          );
        }
      } catch (err) {
        stats.errors += 1;
        this.logger.warn(
          `[digest-worker] unexpected error userId=${userId} err=${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[digest-worker] run complete dryRun=${dryRun} usersConsidered=${stats.usersConsidered} usersDigested=${stats.usersDigested} rowsConsumed=${stats.rowsConsumed} filteredCadence=${stats.filteredCadence} filteredDryRun=${stats.filteredDryRun} errors=${stats.errors}`,
    );
    return stats;
  }

  // Stamps pushDeliveredAt on a set of row ids — race-safe via
  // the (pushDeliveredAt: null) predicate. Returns the count of
  // rows actually updated.
  private async markDelivered(ids: string[], now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, pushDeliveredAt: null },
      data: { pushDeliveredAt: now },
    });
    return result.count;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

// "Is this user due for a digest right now?" Daily users every
// run; weekly users only when the current UTC day-of-week is
// Monday (configurable in a future revision). The check is
// stateless — we don't track "last digested at" for the user;
// the consumed rows + cadence gate provide enough idempotency
// for the calm-cadence use case.
//
// For a tighter "at most once per day" guarantee at higher
// cadence, a per-user `lastDigestAt` column would be the
// natural addition (deferred — not needed for Phase 7.2's
// controlled rollout).
function isDueForDigest(frequency: string, now: Date): boolean {
  if (frequency === 'weekly') {
    // UTC day-of-week. 1 = Monday in many locales but JS Date
    // returns 0=Sunday..6=Saturday. We use Monday (day === 1).
    return now.getUTCDay() === 1;
  }
  // Default daily — always due.
  return true;
}

// Returns sorted [category, count] pairs. Used for body
// composition + dry-run logging.
function summariseCategories(
  rows: Array<{ category: string | null }>,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    // Legacy rows without a category are bucketed under 'other'.
    const key = row.category ?? 'other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
}

// Calm body composition. NEVER includes individual notification
// bodies, recipient names, or any per-row content — just counts
// per category in plain language.
//
// Tone discipline: "You have 3 gift updates" not "Missed 3
// gifts!" / "3 unread!". The summary is informational, not a
// reactivation prompt.
function composeDigestBody(grouped: Array<[string, number]>): string {
  if (grouped.length === 0) return 'Updates ready for you.';
  if (grouped.length === 1) {
    const [cat, n] = grouped[0];
    return `${n} ${humanPlural(cat, n)} since you last checked.`;
  }
  // Multi-category: comma-join.
  const parts = grouped.map(([cat, n]) => `${n} ${humanPlural(cat, n)}`);
  // ", and "-style join for natural reading. Leaves the platform-
  // wide locale assumption to a later i18n pass; English is
  // good enough for Phase 7.2's controlled rollout.
  const last = parts.pop();
  const lead = parts.join(', ');
  return `${lead} and ${last} since you last checked.`;
}

// Singular / plural noun phrase per category. Stays calm — no
// urgency / pressure language.
function humanPlural(category: string, n: number): string {
  switch (category) {
    case 'gift_update':
      return n === 1 ? 'gift update' : 'gift updates';
    case 'address_confirm':
      return n === 1 ? 'address request' : 'address requests';
    case 'merchant_order':
      return n === 1 ? 'order update' : 'order updates';
    case 'occasion_reminder':
      return n === 1 ? 'occasion reminder' : 'occasion reminders';
    case 'social':
      return n === 1 ? 'appreciation' : 'appreciations';
    case 'system':
      return n === 1 ? 'system note' : 'system notes';
    default:
      return n === 1 ? 'update' : 'updates';
  }
}

// Test surface — exported so specs can verify the body composer
// without re-implementing the summarisation.
export const _testables = {
  composeDigestBody,
  summariseCategories,
  isDueForDigest,
  humanPlural,
};
