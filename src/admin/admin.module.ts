import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminWorkersController } from './admin-workers.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StoresModule } from '../stores/stores.module';
import { OpsRolesModule } from '../ops-roles/ops-roles.module';
import { NotificationsModule } from '../notifications/notifications.module';

// AdminModule. Pulls StoresModule for the v2 review endpoints
// (storeDetail / reviewStore reuse the same canonical projection
// + transition rules the owner-side endpoints use). OpsRolesModule
// provides the granular permission layer that gates writes within
// the admin surface (PATCH plan / featured / status / ops-role
// assignment) on top of the coarse AdminGuard.
//
// Phase 7.2 — NotificationsModule import + AdminWorkersController
// expose the manual-trigger endpoints for the occasion-reminder
// + digest workers. Both endpoints require admin role; the
// workers themselves still gate on QIFT_OCCASION_REMINDER_FIRING_
// ENABLED / QIFT_DIGEST_WORKER_ENABLED unless the operator
// passes forceDryRun.
@Module({
  imports: [StoresModule, OpsRolesModule, NotificationsModule],
  controllers: [AdminController, AdminWorkersController],
  providers: [AdminService, AdminGuard, PrismaService],
})
export class AdminModule {}
