import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  NotificationCategoriesController,
  NotificationPreferencesController,
} from './notification-preferences.controller';
import { PrismaService } from '../prisma/prisma.service';
import { PushModule } from '../push/push.module';

// Phase 7.1 expanded the module:
//
//   NotificationsService        — public surface used by gift /
//                                 store / payment / etc. flows.
//                                 Wire shape unchanged; internally
//                                 routes through the orchestrator.
//   NotificationOrchestrator    — composes category registry +
//                                 budget engine + quiet hours +
//                                 preferences to produce a final
//                                 delivery decision.
//   NotificationPreferencesService — owns the per-user
//                                 NotificationPreferences row
//                                 lifecycle.
//   *Controllers                — REST surface for the bell list +
//                                 preferences PATCH +
//                                 categories catalogue.
//
// What is intentionally NOT registered:
//   - An occasion-reminder firing worker (gated off in Phase 7.1
//     behind a feature flag; the worker module lands in 7.2 once
//     this foundation is observed in production).
//   - Real SMS / email channel providers (architecturally seam'd
//     for in project_external_integrations_architecture.md;
//     adapters land per-domain as commercial onboarding completes).
//   - A digest batch worker (Phase 7.2 — reads the
//     pushDeliveredAt-null tail and bundles per-user).
//
// NotificationsService is exported so GiftsService (and any other
// producer) can keep injecting it for trigger() calls. The
// orchestrator + preferences service stay internal to the module
// (nothing outside notifications/ should know about them).
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
    PrismaService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
