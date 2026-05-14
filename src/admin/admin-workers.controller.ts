// Phase 7.2 — admin-only manual triggers for the notification
// workers. No cron, no scheduler — operators invoke these
// endpoints when they want a worker run.
//
// Why manual-only:
//   - Cautious activation strategy. Each invocation is a
//     deliberate operator action with logged stats.
//   - Lets us validate the workers in production with real data
//     before turning on automatic scheduling.
//   - Once observed across a few manual runs, adding a
//     @nestjs/schedule cron is a small follow-up.
//
// Guards: JwtAuthGuard + AdminGuard. Non-admin viewers get 403;
// the workers themselves still gate on their feature flags so
// even an admin clicking the button while the flag is off gets
// a "skipped — feature flag off" response.
//
// Operator workflow:
//   1. Set QIFT_REMINDER_DRY_RUN=true on the server.
//   2. POST /admin/workers/run-reminders → logs what WOULD fire.
//   3. Inspect logs + ReminderFiring table.
//   4. Drop QIFT_REMINDER_DRY_RUN, set QIFT_REMINDER_ALLOWLIST=
//      <your-userId>.
//   5. POST /admin/workers/run-reminders → you receive real
//      reminders; everyone else still skipped.
//   6. Expand allowlist / sample percent gradually.
//
// The `?dryRun=true` query param lets operators preview WITHOUT
// changing the env, useful for one-off "what's pending right
// now" checks.

import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminGuard } from './admin.guard';
import { OccasionReminderWorker } from '../notifications/occasion-reminder-worker.service';
import { DigestWorker } from '../notifications/digest-worker.service';

@Controller('admin/workers')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminWorkersController {
  constructor(
    private reminderWorker: OccasionReminderWorker,
    private digestWorker: DigestWorker,
  ) {}

  // POST /admin/workers/run-reminders?dryRun=true
  //
  // Manually trigger the occasion-reminder worker. Returns the
  // run statistics. Dry-run mode is supported via the query
  // param OR the QIFT_REMINDER_DRY_RUN env (either flips it on).
  @Post('run-reminders')
  async runReminders(@Query('dryRun') dryRun?: string) {
    const forceDryRun = dryRun === 'true';
    return this.reminderWorker.runOnce({ forceDryRun });
  }

  // POST /admin/workers/run-digest?dryRun=true&cadence=force_daily
  //
  // Manually trigger the digest worker. Optional `cadence`
  // param overrides per-user digestFrequency for the run — used
  // for testing weekly users without waiting for Monday.
  //   - cadence=force_daily   — process every user as if daily
  //   - cadence=force_weekly  — same but as weekly
  //   - cadence (unset)       — use stored per-user frequency
  @Post('run-digest')
  async runDigest(
    @Query('dryRun') dryRun?: string,
    @Query('cadence') cadence?: string,
  ) {
    const forceDryRun = dryRun === 'true';
    const cadenceOverride =
      cadence === 'force_daily'
        ? 'force_daily'
        : cadence === 'force_weekly'
          ? 'force_weekly'
          : undefined;
    return this.digestWorker.runOnce({ forceDryRun, cadenceOverride });
  }

  // POST /admin/workers/cleanup-stale-reminder-claims
  //
  // Operator recovery for stuck ReminderFiring rows. A 'claimed'
  // row means the worker inserted the idempotency anchor but the
  // orchestrator call never completed (crash / unexpected throw).
  // The (reminderId, occurrenceAt) pair is then permanently
  // blocked by the unique constraint until this endpoint runs.
  //
  // Query params:
  //   - dryRun       (default 'true')  — SAFE DEFAULT. Preview the
  //                                       affected rows without
  //                                       mutating. Pass 'false' to
  //                                       actually write.
  //   - staleHoursOld (default 24)     — Only consider rows whose
  //                                       firedAt is older than
  //                                       this. Clamped to [1, 720].
  //   - forceClear   (default 'false') — DESTRUCTIVE. When 'true'
  //                                       AND dryRun='false', the
  //                                       rows are DELETED so the
  //                                       (reminderId,
  //                                       occurrenceAt) unique key
  //                                       releases and re-fire is
  //                                       possible. Risks duplicate
  //                                       push if the original
  //                                       orchestrator call had
  //                                       already partly run. Use
  //                                       only with operator
  //                                       evidence the orchestrator
  //                                       never ran.
  //
  // Default (no forceClear): rows transition to status='failed'
  // with reason='stale_claim_recovered'. The user misses this one
  // reminder occurrence; idempotency stays intact; no duplicate
  // risk. This is the recommended cleanup.
  //
  // Returns a structured report:
  //   { dryRun, forceClear, staleHoursOld, considered, recovered,
  //     cleared, errors, sampleIds }
  // — operator cross-references `sampleIds` with the worker logs
  // to investigate root cause.
  @Post('cleanup-stale-reminder-claims')
  async cleanupStaleReminderClaims(
    @Query('dryRun') dryRun?: string,
    @Query('staleHoursOld') staleHoursOld?: string,
    @Query('forceClear') forceClear?: string,
  ) {
    // dryRun default = true. Explicit 'false' string is the only
    // way to opt out. Anything else (including unset, 'TRUE',
    // garbage) keeps dryRun=true — protects against typo'd
    // operator commands actually writing.
    const dryRunValue = dryRun !== 'false';
    // forceClear default = false. Requires explicit 'true' to
    // engage destructive mode. Combined with dryRun's opt-out
    // default, the destructive path requires BOTH explicit
    // overrides: `?dryRun=false&forceClear=true`.
    const forceClearValue = forceClear === 'true';
    let staleHoursOldValue: number | undefined;
    if (staleHoursOld !== undefined) {
      const parsed = Number.parseInt(staleHoursOld, 10);
      if (Number.isFinite(parsed)) staleHoursOldValue = parsed;
    }
    return this.reminderWorker.cleanupStaleClaims({
      dryRun: dryRunValue,
      forceClear: forceClearValue,
      staleHoursOld: staleHoursOldValue,
    });
  }
}
