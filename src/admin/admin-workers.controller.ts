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
}
