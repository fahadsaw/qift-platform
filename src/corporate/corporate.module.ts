import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from '../admin/admin.guard';
import { OpsRolesModule } from '../ops-roles/ops-roles.module';
import { AuditModule } from '../audit/audit.module';
import { OrgService } from './org.service';
import { OrgRoleGuard } from './org-role.guard';
import { OrgController } from './org.controller';
import { OrgAdminController } from './org-admin.controller';

// Corporate Foundation module (PR 1: org spine).
//
// /org/*        — org plane (JwtAuthGuard + OrgRoleGuard).
// /admin/orgs/* — Qift-ops review surface (triple-guarded,
//                 org.review permission).
//
// OpsRolesModule supplies OpsRoleGuard + OpsRolesService for the
// admin surface; AdminGuard + PrismaService are provided locally
// (no global PrismaModule — same pattern as BetaAccessModule).
// AuditModule: every org lifecycle change persists to AuditLog.
//
// Later Corporate Foundation PRs (roster import, campaigns, dispatch,
// claim flow) extend THIS module — they share the OrgRoleGuard tenant
// boundary rather than re-implementing it.
@Module({
  imports: [OpsRolesModule, AuditModule],
  controllers: [OrgController, OrgAdminController],
  providers: [OrgService, OrgRoleGuard, AdminGuard, PrismaService],
  exports: [OrgService],
})
export class CorporateModule {}
