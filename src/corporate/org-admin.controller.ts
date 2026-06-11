import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../admin/admin.guard';
import {
  OpsRoleGuard,
  RequireOpsPermission,
} from '../ops-roles/ops-role.guard';
import { OrgService } from './org.service';
import type { OrgReviewAction } from './org.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// /admin/orgs/* — Qift-ops review surface for organizations.
//
// Triple-guarded exactly like the beta + store admin surfaces:
// JwtAuthGuard → AdminGuard → OpsRoleGuard with class-level
// @RequireOpsPermission('org.review') (held by super_admin +
// operations_manager). This is the OPS plane — holding org.review
// grants zero org-plane powers (no seat ⇒ no /org/:orgId access);
// the planes never inherit (Corporate Core v2 §7).
@Controller('admin/orgs')
@UseGuards(JwtAuthGuard, AdminGuard, OpsRoleGuard)
@RequireOpsPermission('org.review')
export class OrgAdminController {
  constructor(private readonly orgs: OrgService) {}

  // Review queue. ?status=submitted is the default operator view;
  // unknown status values fall back to the unfiltered list.
  @Get()
  list(@Query('status') status?: string) {
    return this.orgs.listOrgsForReview(status);
  }

  @Get(':orgId')
  getOrg(@Param('orgId') orgId: string) {
    return this.orgs.adminGetOrg(orgId);
  }

  // action ∈ { approve, reject, request_changes }; reason is required
  // for the non-approve actions and is shown to the org verbatim.
  @Post(':orgId/review')
  review(
    @Param('orgId') orgId: string,
    @Body() body: { action: OrgReviewAction; reason?: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.orgs.reviewOrg(
      req.user.userId,
      orgId,
      body?.action as OrgReviewAction,
      body?.reason ?? null,
    );
  }
}
