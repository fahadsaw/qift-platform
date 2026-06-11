import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OrgRoleGuard, RequireOrgRole } from './org-role.guard';
import type { OrgContext } from './org-role.guard';
import { OrgService } from './org.service';
import type { CreateOrgInput } from './org.service';

type AuthedRequest = {
  user: { userId: string; qiftUsername: string };
  orgContext?: OrgContext;
};

// /org/* — the org plane (Corporate Foundation PR 1).
//
// JwtAuthGuard populates req.user; OrgRoleGuard enforces per-route
// @RequireOrgRole and attaches req.orgContext for :orgId routes.
// Routes WITHOUT the decorator (create, mine) are not org-scoped —
// they operate on the caller's own identity only.
//
// orgId always flows from req.orgContext (guard-verified), never from
// the body — tenant scoping is structural, not per-handler discipline.
@Controller('org')
@UseGuards(JwtAuthGuard, OrgRoleGuard)
export class OrgController {
  constructor(private readonly orgs: OrgService) {}

  // Any authenticated user may open a draft org; they become its
  // owner seat. Review gating happens at submit, not create.
  @Post()
  create(@Body() body: CreateOrgInput, @Req() req: AuthedRequest) {
    return this.orgs.createOrg(req.user.userId, body ?? {});
  }

  // Declared before :orgId so the literal segment wins the match.
  @Get('mine')
  mine(@Req() req: AuthedRequest) {
    return this.orgs.myOrgs(req.user.userId);
  }

  // Any active seat may read the org profile.
  @Get(':orgId')
  @RequireOrgRole()
  getOrg(@Req() req: AuthedRequest) {
    return this.orgs.getOrg(req.orgContext!.orgId);
  }

  // Submit for Qift review. admin-or-owner (owner satisfies any list).
  @Post(':orgId/submit')
  @RequireOrgRole('admin')
  submit(@Req() req: AuthedRequest) {
    return this.orgs.submitOrg(req.user.userId, req.orgContext!.orgId);
  }
}
