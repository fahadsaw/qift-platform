// Phase 7.2 — OccasionReminderWorker.
//
// Reads enabled OccasionReminder rows, computes whether each is
// in its firing window, and dispatches via NotificationOrchestrator.
//
// CRITICAL invariants (any one breaking is a regression):
//
//   1. Idempotency. A reminder fires AT MOST ONCE per occasion
//      occurrence. The unique constraint on
//      ReminderFiring(reminderId, occurrenceAt) is the load-bearing
//      guarantee. Two worker runs racing on the same (reminder,
//      occurrence) collide there; exactly one wins.
//
//   2. Insert-first ordering. The worker INSERTS ReminderFiring
//      BEFORE calling the orchestrator. If the orchestrator throws
//      (DB error / unexpected exception), the 'claimed' row stays
//      and prevents the next worker run from re-firing. A separate
//      audit pass can resolve stale claims.
//
//   3. Never bypass the orchestrator. The worker MUST go through
//      NotificationOrchestrator.enqueue — that's where budgets,
//      quiet hours, per-user opt-outs, and the priority discipline
//      get applied. Calling prisma.notification.create directly
//      would silently break the calm-by-default contract.
//
//   4. Privacy: the reminder body uses ONLY the owner's own
//      occasion.label (which they typed) or the kind-translation
//      key. No relationship data, no related-user identity. The
//      title is generic ("A moment coming up"). The deep link
//      points at /occasions, an authenticated route.
//
//   5. Activation: gated by QIFT_OCCASION_REMINDER_FIRING_ENABLED.
//      Default OFF. The worker REFUSES to fire when the flag is
//      off, even when invoked manually (admin endpoint logs the
//      skip reason).
//
//   6. Controlled rollout: per-user gates applied AFTER the
//      activation flag passes:
//        - QIFT_REMINDER_DRY_RUN — runs everything, logs what
//          WOULD fire, doesn't insert ReminderFiring rows or call
//          the orchestrator
//        - QIFT_REMINDER_ALLOWLIST — comma-separated user-ids;
//          when set, ONLY listed users have reminders processed
//        - QIFT_REMINDER_USER_SAMPLE_PERCENT — stable hash-based
//          bucketing so a user at 7% stays at 7% across runs
//
// What this worker does NOT do:
//   - Schedule itself. There's no cron / setInterval here. The
//     worker is invoked via POST /admin/workers/run-reminders or
//     a future scheduler. Phase 7.2 ships the manual-trigger
//     pattern — the most cautious activation shape.
//   - Send digests. The DigestWorker is a separate service.
//   - Fire mandatory categories. Reminders are
//     category='occasion_reminder' (optional, opt-outable, capped).

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { NotificationCategory } from './notification-categories';
import {
  isOccasionReminderFiringEnabled,
  isReminderDryRun,
  reminderProcessDecision,
} from './notification-feature-flags';
import { nextOccurrence } from '../occasions/occasion-recurrence';
import type { Calendar } from '../lib/hijri';

// ── Result shapes (telemetry-friendly) ─────────────────────────

export type ReminderRunResult = {
  // Did the worker actually do anything? When false, look at
  // `skippedReason` for the cause.
  ran: boolean;
  skippedReason?: 'feature_flag_off' | 'manual_skip';
  // Aggregate counts. The audit row in ReminderFiring is the
  // record-of-truth; these are surfaced for the admin endpoint's
  // return value + logging.
  considered: number; // candidate reminders inspected
  inWindow: number; // candidates whose firing window matches now
  fired: number; // orchestrator returned 'sent'
  digested: number; // orchestrator returned 'queued_for_digest'
  suppressed: number; // orchestrator returned 'suppressed' OR
  //   pre-orchestrator filter (allowlist /
  //   sample / dry-run) skipped the user
  errors: number; // unexpected exceptions; row stays 'claimed'
  // Dry-run / allowlist / sample-percent rejection counts. Useful
  // for the operator to confirm rollout shape is working.
  filteredAllowlist: number;
  filteredSamplePercent: number;
  filteredDryRun: number;
  // Stale-claim early-warning. Count of ReminderFiring rows still
  // stuck in 'claimed' status more than STALE_CLAIM_WARN_HOURS
  // hours after their firedAt. In steady state this should be
  // near zero; a non-zero reading flags that the orchestrator
  // crashed mid-fire and the (reminderId, occurrenceAt) pair is
  // permanently blocked by the unique constraint until an
  // operator runs the cleanup endpoint. Pure metric — does NOT
  // mutate or recover; recovery is opt-in via the dedicated
  // admin endpoint (see cleanupStaleClaims below).
  staleClaims: number;
};

export type ReminderRunOptions = {
  // Test seam — lets specs freeze "now" without monkey-patching
  // the system clock.
  now?: Date;
  // Operator-supplied override — when true, runs in dry-run mode
  // regardless of QIFT_REMINDER_DRY_RUN. Lets admins safely
  // preview "what would fire right now" without changing env.
  forceDryRun?: boolean;
};

// ── Stale-claim cleanup ────────────────────────────────────────
//
// A ReminderFiring row in 'claimed' status represents an in-flight
// fire that never completed: the worker inserted the row (which
// reserved the unique key against duplicate fires), called the
// orchestrator, and then crashed before transitioning the row to
// its terminal status ('sent' / 'suppressed' / 'failed').
//
// The unique constraint on (reminderId, occurrenceAt) is the
// idempotency anchor — it's WHY we insert the claim before the
// orchestrator call. The downside is that a crashed fire leaves
// the (reminderId, occurrenceAt) pair permanently blocked. For a
// yearly birthday, that means the user misses this year's
// reminder. For a once-only occasion, they miss it entirely.
//
// Two recovery modes are offered, BOTH explicitly opt-in:
//
//   1. SAFE DEFAULT (forceClear = false): transition the stale
//      'claimed' row to status='failed' with
//      reason='stale_claim_recovered'. The unique key STILL holds
//      — no retry possible — so no duplicate fire risk. The user
//      misses this reminder occurrence; recovery happens
//      automatically at the next occurrence (next year for yearly,
//      never for once-only). This is the cautious posture: better
//      to lose ONE reminder than to risk a duplicate after a
//      partial fire (we cannot tell from the row alone whether
//      the orchestrator wrote a Notification + fired push, or
//      crashed before the orchestrator ran at all).
//
//   2. DESTRUCTIVE OPT-IN (forceClear = true): DELETE the stale
//      'claimed' rows entirely, releasing the unique constraint.
//      The next worker run can then re-fire. USE WITH CARE — if
//      the orchestrator actually wrote a Notification + sent push
//      before crashing, the re-fire will duplicate. Operator
//      should only use this when they have evidence the
//      orchestrator never ran (e.g. logs show "claim inserted"
//      but no "orchestrator returned").
//
// Dry-run is the default for both modes — the cleanup writes
// nothing unless `dryRun: false` is explicitly passed.

const STALE_CLAIM_WARN_HOURS = 24;
const STALE_CLAIM_BATCH_LIMIT = 1000;
const STALE_CLAIM_SAMPLE_LIMIT = 10;

export type StaleClaimCleanupOptions = {
  // Test seam.
  now?: Date;
  // Rows with firedAt older than this are eligible. Default 24.
  // Clamped to [1, 720] (1 hour to 30 days) at the boundary.
  staleHoursOld?: number;
  // Default true — even the SAFE mode requires explicit opt-out
  // (`dryRun: false`) to actually write. Operators should always
  // dry-run first to see what would be touched.
  dryRun?: boolean;
  // Default false — the DESTRUCTIVE mode requires explicit
  // `forceClear: true`. Even then, dry-run still wins; both flags
  // must be set explicitly to delete.
  forceClear?: boolean;
};

export type StaleClaimCleanupResult = {
  dryRun: boolean;
  forceClear: boolean;
  staleHoursOld: number;
  // Count of stale 'claimed' rows discovered.
  considered: number;
  // Rows transitioned 'claimed' → 'failed' (safe mode, dryRun=false).
  recovered: number;
  // Rows deleted (destructive mode, dryRun=false + forceClear=true).
  cleared: number;
  errors: number;
  // Up to STALE_CLAIM_SAMPLE_LIMIT row ids for operator inspection.
  // Helps cross-reference with logs / notification audit.
  sampleIds: string[];
};

// ── Service ────────────────────────────────────────────────────

@Injectable()
export class OccasionReminderWorker {
  private readonly logger = new Logger(OccasionReminderWorker.name);

  constructor(
    private prisma: PrismaService,
    private orchestrator: NotificationOrchestrator,
  ) {}

  async runOnce(opts: ReminderRunOptions = {}): Promise<ReminderRunResult> {
    const now = opts.now ?? new Date();
    const dryRun = opts.forceDryRun === true || isReminderDryRun();

    const stats: ReminderRunResult = {
      ran: true,
      considered: 0,
      inWindow: 0,
      fired: 0,
      digested: 0,
      suppressed: 0,
      errors: 0,
      filteredAllowlist: 0,
      filteredSamplePercent: 0,
      filteredDryRun: 0,
      staleClaims: 0,
    };

    // Early-warning telemetry: count stale 'claimed' rows that the
    // orchestrator never completed. Cheap (indexed by status +
    // firedAt range), runs on every invocation, surfaces in the
    // log line. Operators should monitor: if this number trends
    // up, run the cleanup endpoint. We DO NOT mutate stale rows
    // here — recovery is a deliberate operator action via
    // `cleanupStaleClaims()`.
    try {
      stats.staleClaims = await this.prisma.reminderFiring.count({
        where: {
          status: 'claimed',
          firedAt: {
            lt: new Date(
              now.getTime() - STALE_CLAIM_WARN_HOURS * 60 * 60 * 1000,
            ),
          },
        },
      });
    } catch (err) {
      // Count failure must not block the run — log + continue.
      this.logger.warn(
        `[reminder-worker] stale-claim count failed: ${(err as Error).message}`,
      );
    }

    // Activation flag. Even an admin manual trigger respects this
    // — the flag is what holds the door closed until rollout
    // begins. forceDryRun is the escape hatch: it lets operators
    // PREVIEW without flipping the activation flag.
    if (!isOccasionReminderFiringEnabled() && !dryRun) {
      this.logger.log(
        '[reminder-worker] skipped — QIFT_OCCASION_REMINDER_FIRING_ENABLED is off',
      );
      return { ...stats, ran: false, skippedReason: 'feature_flag_off' };
    }

    // Candidate fetch — enabled reminders whose parent occasion +
    // owner are both live. We pull all enabled reminders in one
    // query then filter in memory; at the current scale (~hundreds
    // to low-thousands of rows) this is fine. When OccasionReminder
    // grows past ~100k, this becomes a per-window indexed query
    // shifted to a scheduled cron with a sliding date filter.
    const candidates = await this.prisma.occasionReminder.findMany({
      where: {
        enabled: true,
        // Parent occasion must be live.
        occasion: { deactivatedAt: null },
        // Owner must be live.
        user: { deletedAt: null },
      },
      select: {
        id: true,
        userId: true,
        daysBefore: true,
        occasion: {
          select: {
            id: true,
            calendar: true,
            year: true,
            month: true,
            day: true,
            recurrence: true,
            label: true,
            kind: true,
          },
        },
      },
    });

    stats.considered = candidates.length;

    // Process each candidate. We do this sequentially so a worker
    // crash leaves a known position in the audit log; a parallel
    // scan could double-claim if the unique-key insert races.
    for (const c of candidates) {
      try {
        // Compute the next occurrence date for this occasion (UTC
        // midnight). Pure function — no DB.
        const occurrenceAt = nextOccurrence(
          {
            calendar: c.occasion.calendar as Calendar,
            year: c.occasion.year,
            month: c.occasion.month,
            day: c.occasion.day,
            recurrence: c.occasion.recurrence as 'once' | 'yearly',
          },
          now,
        );
        if (occurrenceAt === null) {
          // Once-only occasion that's already passed. Skip
          // forever — not in any window.
          continue;
        }

        // The firing day: occurrenceAt - daysBefore days, at UTC
        // midnight. Worker fires only on this specific UTC day so
        // multiple runs during the day collapse via the
        // ReminderFiring unique constraint.
        const firingDay = subtractDaysUtc(occurrenceAt, c.daysBefore);
        const today = startOfUtcDay(now);
        if (firingDay.getTime() !== today.getTime()) {
          // Either too early (firingDay in the future) or too late
          // (firingDay in the past — worker downtime case). Skip.
          continue;
        }
        stats.inWindow += 1;

        // Per-user rollout gates. Applied AFTER the firing-window
        // check so the stats above reflect "real candidates" and
        // these stats reflect "filtered by rollout shape".
        //
        // We use the decision-returning variant so the counter
        // can distinguish allowlist rejection from sample-percent
        // rejection — operators rolling out gradually need to see
        // which gate is doing the filtering. Lumping them was the
        // initial cut; the split is the honest telemetry.
        const dec = reminderProcessDecision(c.userId);
        if (dec.kind === 'reject_allowlist') {
          stats.filteredAllowlist += 1;
          continue;
        }
        if (dec.kind === 'reject_sample_percent') {
          stats.filteredSamplePercent += 1;
          continue;
        }

        // Dry-run: log what would fire, don't write the claim
        // row, don't call the orchestrator. Idempotent against
        // future real runs (no row written).
        if (dryRun) {
          this.logger.log(
            `[reminder-worker] DRY-RUN would fire reminderId=${c.id} userId=${c.userId} occasionId=${c.occasion.id} kind=${c.occasion.kind} occurrence=${occurrenceAt.toISOString()} daysBefore=${c.daysBefore}`,
          );
          stats.filteredDryRun += 1;
          continue;
        }

        // Atomic claim. The unique constraint on
        // (reminderId, occurrenceAt) is the idempotency anchor —
        // a duplicate insert throws P2002 which we treat as "this
        // (reminder, occurrence) was already fired (or claimed)
        // by a concurrent worker run".
        let claim: { id: string };
        try {
          claim = await this.prisma.reminderFiring.create({
            data: {
              reminderId: c.id,
              occurrenceAt,
              status: 'claimed',
            },
            select: { id: true },
          });
        } catch (err) {
          // P2002 = unique constraint violation. Anything else is
          // a real error.
          if ((err as { code?: string }).code === 'P2002') {
            // Already fired (or being fired concurrently).
            // Honour the prior claim; don't touch.
            continue;
          }
          throw err;
        }

        // Now the orchestrator call. Body construction is calm
        // by design — see Section 4 of the doc-comment above.
        const body = composeReminderBody(c.occasion, c.daysBefore);
        try {
          const result = await this.orchestrator.enqueue({
            userId: c.userId,
            type: 'occasion.reminder',
            category: NotificationCategory.OccasionReminder,
            title: body.title,
            body: body.body,
            link: '/occasions',
            now,
          });
          await this.prisma.reminderFiring.update({
            where: { id: claim.id },
            data: {
              status:
                result.kind === 'sent'
                  ? 'sent'
                  : result.kind === 'queued_for_digest'
                    ? 'sent' // in-app row landed; counts as fired
                    : 'suppressed',
              reason:
                result.kind === 'sent'
                  ? null
                  : result.kind === 'queued_for_digest'
                    ? result.reason
                    : result.reason,
            },
          });
          if (result.kind === 'sent') stats.fired += 1;
          else if (result.kind === 'queued_for_digest') stats.digested += 1;
          else stats.suppressed += 1;
        } catch (err) {
          // Orchestrator threw unexpectedly. Leave the claim as
          // 'claimed' so a future audit pass can investigate;
          // do NOT clear it (clearing would re-fire on the next
          // worker run, which is worse than a missed reminder).
          stats.errors += 1;
          this.logger.warn(
            `[reminder-worker] orchestrator threw for reminderId=${c.id} userId=${c.userId} err=${(err as Error).message}`,
          );
        }
      } catch (err) {
        // Outer catch — covers the nextOccurrence resolution +
        // the unique-constraint-rethrow path. Same posture:
        // count + log, don't crash the whole batch.
        stats.errors += 1;
        this.logger.warn(
          `[reminder-worker] unexpected error processing reminderId=${c.id} err=${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[reminder-worker] run complete dryRun=${dryRun} considered=${stats.considered} inWindow=${stats.inWindow} fired=${stats.fired} digested=${stats.digested} suppressed=${stats.suppressed} filteredAllowlist=${stats.filteredAllowlist} filteredSamplePercent=${stats.filteredSamplePercent} filteredDryRun=${stats.filteredDryRun} errors=${stats.errors} staleClaims=${stats.staleClaims}`,
    );
    return stats;
  }

  // Operator recovery for stuck 'claimed' ReminderFiring rows.
  //
  // Default mode (safe): transitions stale rows to status='failed'
  // with reason='stale_claim_recovered'. The unique constraint
  // continues to hold — the (reminderId, occurrenceAt) pair stays
  // single-fire forever, so no duplicate push is possible. The
  // user simply misses this particular reminder occurrence.
  //
  // Force-clear mode (destructive): deletes stale rows entirely,
  // releasing the unique key so the next worker run can re-fire.
  // Useful when the operator KNOWS the orchestrator never ran
  // (e.g. claim insert succeeded but the next log line is the
  // crash). Risks duplicate fire if the orchestrator partially
  // ran. ALWAYS dry-run first.
  //
  // Both modes are race-safe: the update / delete uses a
  // `status: 'claimed'` predicate so a concurrent legitimate
  // transition (status flipped to 'sent' between scan and write)
  // is detected and skipped.
  async cleanupStaleClaims(
    opts: StaleClaimCleanupOptions = {},
  ): Promise<StaleClaimCleanupResult> {
    const now = opts.now ?? new Date();
    // Default 24h. Clamp to [1, 720] (1h to 30d) — the lower bound
    // prevents an operator from accidentally clearing in-flight
    // fires; the upper bound is the audit window we care about.
    const requestedHours = opts.staleHoursOld ?? 24;
    const staleHoursOld = Math.min(
      720,
      Math.max(
        1,
        Math.floor(Number.isFinite(requestedHours) ? requestedHours : 24),
      ),
    );
    // SAFE-DEFAULT: dryRun defaults to true. Operators must
    // explicitly pass `dryRun: false` to actually write. Even the
    // non-destructive 'failed' transition requires this opt-in.
    const dryRun = opts.dryRun !== false;
    const forceClear = opts.forceClear === true;

    const threshold = new Date(now.getTime() - staleHoursOld * 60 * 60 * 1000);

    let stale: Array<{ id: string }> = [];
    try {
      stale = await this.prisma.reminderFiring.findMany({
        where: { status: 'claimed', firedAt: { lt: threshold } },
        select: { id: true },
        // Batch limit — first invocation against a bad backlog
        // shouldn't blow up. Operator can re-run to clear more.
        take: STALE_CLAIM_BATCH_LIMIT,
        orderBy: { firedAt: 'asc' },
      });
    } catch (err) {
      // Scan failure short-circuits with a clean error count.
      this.logger.warn(
        `[stale-claim-cleanup] scan failed: ${(err as Error).message}`,
      );
      return {
        dryRun,
        forceClear,
        staleHoursOld,
        considered: 0,
        recovered: 0,
        cleared: 0,
        errors: 1,
        sampleIds: [],
      };
    }

    const considered = stale.length;
    const sampleIds = stale.slice(0, STALE_CLAIM_SAMPLE_LIMIT).map((r) => r.id);
    let recovered = 0;
    let cleared = 0;
    let errors = 0;

    if (dryRun || considered === 0) {
      // Report only. No DB writes. The log line + return value
      // give the operator everything they need to decide.
      this.logger.log(
        `[stale-claim-cleanup] dryRun=${String(dryRun)} forceClear=${String(forceClear)} staleHoursOld=${staleHoursOld} considered=${considered} (no writes — preview only)`,
      );
      return {
        dryRun,
        forceClear,
        staleHoursOld,
        considered,
        recovered: 0,
        cleared: 0,
        errors: 0,
        sampleIds,
      };
    }

    const ids = stale.map((r) => r.id);

    if (forceClear) {
      // DESTRUCTIVE — releases the unique constraint, allows
      // re-fire on next worker run. Race-safe via the status
      // predicate (a concurrent legitimate update to 'sent' won't
      // be deleted).
      try {
        const result = await this.prisma.reminderFiring.deleteMany({
          where: { id: { in: ids }, status: 'claimed' },
        });
        cleared = result.count;
      } catch (err) {
        errors += 1;
        this.logger.warn(
          `[stale-claim-cleanup] forceClear deleteMany failed: ${(err as Error).message}`,
        );
      }
    } else {
      // SAFE DEFAULT — transition to 'failed' with structured
      // reason. The unique key stays held; no retry, no duplicate.
      try {
        const result = await this.prisma.reminderFiring.updateMany({
          where: { id: { in: ids }, status: 'claimed' },
          data: { status: 'failed', reason: 'stale_claim_recovered' },
        });
        recovered = result.count;
      } catch (err) {
        errors += 1;
        this.logger.warn(
          `[stale-claim-cleanup] updateMany failed: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[stale-claim-cleanup] dryRun=false forceClear=${String(forceClear)} staleHoursOld=${staleHoursOld} considered=${considered} recovered=${recovered} cleared=${cleared} errors=${errors}`,
    );
    return {
      dryRun,
      forceClear,
      staleHoursOld,
      considered,
      recovered,
      cleared,
      errors,
      sampleIds,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function subtractDaysUtc(date: Date, days: number): Date {
  const ms = 24 * 60 * 60 * 1000;
  return new Date(date.getTime() - days * ms);
}

// Calm body copy. Generic title + a one-line summary that uses
// only the owner's own typed label (or the kind translation key
// — the frontend looks it up). NO sender identity, NO related-
// user names, NO address content. The deep link goes to the
// authenticated /occasions page; the user opens it to see the
// full context.
//
// daysBefore is rendered as a human phrase ("this week" / "in a
// few days" / "today") so the body reads calmly. Specific day
// counts are intentionally avoided — "in 3 days" feels like a
// countdown; "this week" feels like a quiet note.
function composeReminderBody(
  occasion: {
    label: string | null;
    kind: string;
  },
  daysBefore: number,
): { title: string; body: string } {
  // Translation-key style hint. The frontend renders these via
  // its existing notification-row UI (the bell list). For Phase
  // 7.2 we store the resolved English form on the wire — the
  // i18n lookup happens at write time so the row is locale-
  // stable. (A future refinement could store keys + interpolate
  // at render time.)
  const subject = occasion.label?.trim() || labelForKind(occasion.kind);
  const timing = phraseForDaysBefore(daysBefore);
  return {
    title: 'A moment coming up',
    body: `${subject} — ${timing}`,
  };
}

function phraseForDaysBefore(daysBefore: number): string {
  if (daysBefore <= 0) return 'today';
  if (daysBefore === 1) return 'tomorrow';
  if (daysBefore <= 3) return 'in a few days';
  if (daysBefore <= 7) return 'this week';
  if (daysBefore <= 14) return 'in a couple of weeks';
  if (daysBefore <= 30) return 'this month';
  return 'soon';
}

// English fallback for the occasion kind. The owner's typed
// `label` is always preferred when present; this is the bare
// "Eid al-Fitr" / "Birthday" fallback. Kept lowercase-friendly
// so the body reads naturally.
function labelForKind(kind: string): string {
  const map: Record<string, string> = {
    birthday: 'a birthday',
    anniversary_relationship: 'an anniversary',
    anniversary_work: 'a work anniversary',
    anniversary_other: 'an anniversary',
    eid_al_fitr: 'Eid al-Fitr',
    eid_al_adha: 'Eid al-Adha',
    ramadan: 'Ramadan',
    hijri_new_year: 'Hijri New Year',
    mawlid: 'Mawlid',
    ashura: 'Ashura',
    mothers_day: "Mother's Day",
    fathers_day: "Father's Day",
    saudi_national_day: 'Saudi National Day',
    new_year: 'New Year',
    graduation: 'a graduation',
    engagement: 'an engagement',
    wedding: 'a wedding',
    new_baby: 'a new baby',
    new_home: 'a new home',
    new_job: 'a new job',
    promotion: 'a promotion',
    retirement: 'a retirement',
    degree: 'a degree',
    exam_success: 'an exam',
    milestone: 'a milestone',
    custom: 'an upcoming occasion',
  };
  return map[kind] ?? 'an upcoming occasion';
}
// Tiny export so unit specs can drive composeReminderBody without
// re-implementing the day-phrase logic.
export const _testables = { composeReminderBody, phraseForDaysBefore };
