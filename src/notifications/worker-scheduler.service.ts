// Occasions Activation — the in-process notification worker
// scheduler. This is the "future scheduler" the worker doc-blocks
// anticipated: Phase 7.2 shipped runOnce() + the admin manual
// trigger as the most cautious activation shape; this service adds
// the recurring tick so reminders fire without an operator pressing
// the button every hour.
//
// PATTERN
// Mirrors GiftsAutoDefaultService exactly (plain setInterval, no
// @nestjs/schedule dependency — one hourly tick doesn't justify a
// scheduling framework):
//   - skipped entirely under NODE_ENV=test (jest must not hold
//     open handles; specs call tick() directly)
//   - unref()'d timer so shutdown isn't blocked
//   - boot kick after a short delay so a freshly-restarted server
//     catches anything that fell behind during downtime
//
// SAFETY — TRIPLE-GATED
//   1. QIFT_NOTIFICATION_SCHEDULER_ENABLED (this service) — default
//      OFF; deploying this PR changes nothing in any environment.
//   2. QIFT_OCCASION_REMINDER_FIRING_ENABLED /
//      QIFT_DIGEST_WORKER_ENABLED — each worker's own activation
//      flag, checked here as a cheap pre-gate AND re-checked inside
//      runOnce() (the workers are the authority; this check just
//      avoids no-op churn in the logs).
//   3. The rollout-shape flags (dry-run / allowlist / sample
//      percent) apply inside the workers unchanged — the documented
//      activation ladder in notification-feature-flags.ts works
//      identically whether a run was triggered by an admin or by
//      this tick.
//
// IDEMPOTENCY / MULTI-REPLICA
// Both workers are idempotent by design (ReminderFiring claim rows;
// the digest cadence gate + consumed-row stamps), so overlapping
// runs — two replicas ticking, or an admin manual run racing the
// schedule — converge safely. The hourly cadence is deliberate:
// reminders are day-granularity (daysBefore), so anything between
// 15 minutes and a few hours is equivalent, and hourly keeps the
// worst-case lateness invisible next to a calendar-day target.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OccasionReminderWorker } from './occasion-reminder-worker.service';
import { DigestWorker } from './digest-worker.service';
import {
  isDigestWorkerEnabled,
  isOccasionReminderFiringEnabled,
  isWorkerSchedulerEnabled,
} from './notification-feature-flags';

const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BOOT_KICK_DELAY_MS = 2 * 60 * 1000; // 2 minutes after boot

@Injectable()
export class NotificationWorkerScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationWorkerScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private bootKick: NodeJS.Timeout | null = null;

  constructor(
    private reminderWorker: OccasionReminderWorker,
    private digestWorker: DigestWorker,
  ) {}

  onModuleInit() {
    // Jest must not inherit an open interval; specs exercise tick()
    // directly — same contract as GiftsAutoDefaultService.
    if (process.env.NODE_ENV === 'test') return;

    this.bootKick = setTimeout(() => {
      void this.tick();
    }, BOOT_KICK_DELAY_MS);
    this.bootKick.unref?.();

    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.bootKick) {
      clearTimeout(this.bootKick);
      this.bootKick = null;
    }
  }

  // One scheduler pass. Public so specs (and, if ever needed, an
  // admin endpoint) can invoke it without timers. Never throws —
  // a worker failure is logged and the next tick tries again;
  // reminder and digest failures are isolated from each other.
  async tick(): Promise<void> {
    if (!isWorkerSchedulerEnabled()) return;

    if (isOccasionReminderFiringEnabled()) {
      try {
        const result = await this.reminderWorker.runOnce();
        this.logger.log(
          `[scheduler] reminders tick ${JSON.stringify(result)}`,
        );
      } catch (err) {
        this.logger.error(
          `[scheduler] reminder run failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (isDigestWorkerEnabled()) {
      try {
        const result = await this.digestWorker.runOnce();
        this.logger.log(`[scheduler] digest tick ${JSON.stringify(result)}`);
      } catch (err) {
        this.logger.error(
          `[scheduler] digest run failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
