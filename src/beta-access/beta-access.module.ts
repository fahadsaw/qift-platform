import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { OpsRolesModule } from '../ops-roles/ops-roles.module';
import { AuditModule } from '../audit/audit.module';
import { BetaAccessService } from './beta-access.service';
import { BetaAccessController } from './beta-access.controller';
import { BetaStatusController } from './beta-status.controller';

// Closed Beta Gate module.
//
// Exposes BetaAccessService so AuthModule can inject it into
// AuthService (the registration-gate enforcement point), and registers
// the /admin/beta/* management controller.
//
// OpsRolesModule is imported to supply OpsRoleGuard + OpsRolesService
// (the beta.manage permission check). AdminGuard is provided locally
// (it re-loads the role per request); PrismaService is injected from
// the global PrismaModule.
// AuditModule (PR 7): code + allowlist mutations persist to AuditLog.
// BetaStatusController (PR 8): public { gateEnabled } probe for the
// register page — no guard, no sensitive payload.
@Module({
  imports: [OpsRolesModule, AuditModule],
  controllers: [BetaAccessController, BetaStatusController],
  providers: [BetaAccessService, AdminGuard],
  exports: [BetaAccessService],
})
export class BetaAccessModule {}
