import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from '../admin/admin.guard';
import { OpsRolesModule } from '../ops-roles/ops-roles.module';
import { AuditModule } from '../audit/audit.module';
import { OtpModule } from '../otp/otp.module';
import { OrgService } from './org.service';
import { OrgRoleGuard } from './org-role.guard';
import { OrgController } from './org.controller';
import { OrgAdminController } from './org-admin.controller';
import { RosterService } from './roster.service';
import { RosterPurgeService } from './roster-purge.service';
import { RosterController } from './roster.controller';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';
import { DispatchService } from './dispatch.service';
import { DispatchWorkerService } from './dispatch-worker.service';
import {
  DISPATCH_PROVIDER,
  ManualDispatchProvider,
} from './dispatch-provider';
import { ClaimMintService } from './claim-mint.service';
import { ClaimService } from './claim.service';
import { ClaimController } from './claim.controller';
import { ClaimExportService } from './claim-export.service';
import { ReportService } from './report.service';
import { StoreBusinessService } from './store-business.service';
import { StoreBusinessAdminController } from './store-business-admin.controller';

// Corporate Foundation module (PR 1: org spine, PR 2: roster,
// PR 3: campaigns).
//
// /org/*                — org plane (JwtAuthGuard + OrgRoleGuard).
// /org/:orgId/contacts  — roster import/list/archive (admin seats).
// /org/:orgId/campaigns — campaign drafting + maker–checker
//                         approval state machine + dispatch (PR 4).
// /admin/orgs/*         — Qift-ops review surface (triple-guarded,
//                         org.review permission).
// RosterPurgeService    — retention sweeper, env-gated DEFAULT OFF
//                         (QIFT_ROSTER_PURGE_ENABLED='true').
// DispatchWorkerService — queue processor, env-gated DEFAULT OFF
//                         (QIFT_DISPATCH_WORKER_ENABLED='true');
//                         emergency brake QIFT_DISPATCH_PAUSED.
//                         Provider lane bound to
//                         ManualDispatchProvider — the MVP never
//                         auto-sends (manual-share invariant).
// /claim/*              — PUBLIC account-less claim flow (PR 5):
//                         hashed token → generic teaser → OTP to
//                         the bound channel → identity echo +
//                         reveal → coverage-checked ClaimAddress.
//                         OtpModule supplies the possession proof.
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
  imports: [OpsRolesModule, AuditModule, OtpModule],
  controllers: [
    OrgController,
    OrgAdminController,
    RosterController,
    CampaignController,
    ClaimController,
    StoreBusinessAdminController,
  ],
  providers: [
    OrgService,
    RosterService,
    RosterPurgeService,
    CampaignService,
    DispatchService,
    DispatchWorkerService,
    { provide: DISPATCH_PROVIDER, useClass: ManualDispatchProvider },
    ClaimMintService,
    ClaimService,
    ClaimExportService,
    ReportService,
    StoreBusinessService,
    OrgRoleGuard,
    AdminGuard,
    PrismaService,
  ],
  exports: [OrgService, RosterService, CampaignService, DispatchService],
})
export class CorporateModule {}
