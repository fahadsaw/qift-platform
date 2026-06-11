import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OrgRoleGuard, RequireOrgRole } from './org-role.guard';
import type { OrgContext } from './org-role.guard';
import { RosterService } from './roster.service';

type AuthedRequest = {
  user: { userId: string; qiftUsername: string };
  orgContext?: OrgContext;
};

// /org/:orgId/contacts — roster surface (Corporate Foundation PR 2).
//
// Every route is admin/owner-only: roster rows are employee PII and
// the viewer/approver seats have no business reading them raw
// (approvers get campaign-scoped recipient views in the campaign
// PR). OrgRoleGuard resolves the :orgId param at the class level, so
// orgId always flows from req.orgContext — never the body.
@Controller('org/:orgId/contacts')
@UseGuards(JwtAuthGuard, OrgRoleGuard)
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  // CSV import. Body is { csv: "<file text>" } — the frontend reads
  // the file client-side and posts the text; caps + the
  // address-column privacy gate are enforced server-side.
  @Post('import')
  @RequireOrgRole('admin')
  import(@Body() body: { csv?: string }, @Req() req: AuthedRequest) {
    return this.roster.importRoster(
      req.user.userId,
      req.orgContext!.orgId,
      body?.csv,
    );
  }

  @Get()
  @RequireOrgRole('admin')
  list(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.roster.listContacts(req.orgContext!.orgId, {
      status,
      cursor,
    });
  }

  @Patch(':contactId/archive')
  @RequireOrgRole('admin')
  archive(@Param('contactId') contactId: string, @Req() req: AuthedRequest) {
    return this.roster.archiveContact(
      req.user.userId,
      req.orgContext!.orgId,
      contactId,
    );
  }
}
