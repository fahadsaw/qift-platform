import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  NotificationCategoriesController,
  NotificationPreferencesController,
} from './notification-preferences.controller';
import { OccasionReminderWorker } from './occasion-reminder-worker.service';
import { DigestWorker } from './digest-worker.service';
import { PrismaService } from '../prisma/prisma.service';
import { PushModule } from '../push/push.module';

// Phase 7.2 added the two workers:
//
//   OccasionReminderWorker — reads OccasionReminder rows, fires
//                            via the orchestrator at the right
//                            UTC-day, idempotency anchored on
//                            ReminderFiring(reminderId,
//                            occurrenceAt).
//   DigestWorker           — picks up Notification rows with
//                            pushDeliveredAt=null, bundles per-
//                            user, stamps pushDeliveredAt.
//
// Both workers are EXPORTED so AdminController can trigger them
// manually via the /admin/workers/* endpoints. Activation stays
// gated by per-worker feature flags (default OFF).
//
// What is STILL not registered:
//   - Real SMS / email channel providers — adapters land per
//     project_external_integrations_architecture.md as commercial
//     onboarding completes.
//   - A scheduler (cron / @nestjs/schedule). Phase 7.2 ships the
//     manual-trigger pattern — admins invoke the endpoint when
//     ready. Adding a cron is a one-line change once telemetry
//     from manual runs is observed.
@Module({
  imports: [PushModule],
  controllers: [
    NotificationsController,
    NotificationPreferencesController,
    NotificationCategoriesController,
  ],
  providers: [
    NotificationsService,
    NotificationOrchestrator,
    NotificationPreferencesService,
    OccasionReminderWorker,
    DigestWorker,
    PrismaService,
  ],
  // Workers exported so AdminModule can inject them for the
  // manual-trigger endpoints. NotificationsService stays exported
  // for the existing gift / order / payment producers.
  exports: [NotificationsService, OccasionReminderWorker, DigestWorker],
})
export class NotificationsModule {}
