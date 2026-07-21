import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminWorkersController } from './admin-workers.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { StoresModule } from '../stores/stores.module';
import { OpsRolesModule } from '../ops-roles/ops-roles.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { FinancialLedgerModule } from '../financial/financial-ledger.module';
import { SettlementModule } from '../settlement/settlement.module';
import { VatFactsService } from './vat-facts.service';

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
// AuditModule (PR 7): AdminService persists every state-changing
// admin action to the AuditLog table.
@Module({
  imports: [
    StoresModule,
    OpsRolesModule,
    NotificationsModule,
    AuditModule,
    // Track B2 / PE-11 — the constitutionally required reconciliation
    // surface (Financial Constitution Ch. 5.6) rides the admin plane.
    FinancialLedgerModule,
    // SETTLE-1 (Track C PR 2) — receipts + eligibility ride the same
    // admin plane behind finance.receipts; the services live in the
    // settlement module (RULE 1: calculations never leave it).
    SettlementModule,
  ],
  controllers: [AdminController, AdminWorkersController],
  providers: [VatFactsService, AdminService, AdminGuard],
})
export class AdminModule {}
