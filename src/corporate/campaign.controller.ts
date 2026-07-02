import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OrgRoleGuard, RequireOrgRole } from './org-role.guard';
import type { OrgContext } from './org-role.guard';
import { CampaignService } from './campaign.service';
import type { CampaignDraftInput } from './campaign.service';
import { DispatchService } from './dispatch.service';
import { ReportService } from './report.service';
import { InvoiceService } from './invoice.service';

type AuthedRequest = {
  user: { userId: string; qiftUsername: string };
  orgContext?: OrgContext;
};

// /org/:orgId/campaigns — campaign surface (Corporate Foundation
// PR 3).
//
// Role split per Corporate Core v2 §4 (maker–checker):
//   admin    — drafts, edits, submits, cancels (the maker).
//   approver — approves / requests changes (the checker). The
//              person-level creator≠approver lock lives in the
//              service on top of this role split.
//   any seat — list view (counts only, no recipient PII).
//   detail   — admin + approver (the checker must see exactly what
//              they're approving); viewer is excluded because the
//              detail includes recipient names.
// Owner satisfies every role gate but NOT the person-level SoD lock.
@Controller('org/:orgId/campaigns')
@UseGuards(JwtAuthGuard, OrgRoleGuard)
export class CampaignController {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly dispatch: DispatchService,
    private readonly reports: ReportService,
    private readonly invoices: InvoiceService,
  ) {}

  @Post()
  @RequireOrgRole('admin')
  create(@Body() body: CampaignDraftInput, @Req() req: AuthedRequest) {
    return this.campaigns.createCampaign(
      req.user.userId,
      req.orgContext!.orgId,
      body ?? {},
    );
  }

  @Get()
  @RequireOrgRole()
  list(@Req() req: AuthedRequest) {
    return this.campaigns.listCampaigns(req.orgContext!.orgId);
  }

  @Get(':campaignId')
  @RequireOrgRole('admin', 'approver')
  detail(@Param('campaignId') campaignId: string, @Req() req: AuthedRequest) {
    return this.campaigns.getCampaign(req.orgContext!.orgId, campaignId);
  }

  // The corporate invoice for a campaign (PR 4). Issued at approval;
  // returns null before approval. Amounts + status only — no employee
  // identity, address, or claim data. admin+approver, matching detail.
  @Get(':campaignId/invoice')
  @RequireOrgRole('admin', 'approver')
  invoice(@Param('campaignId') campaignId: string, @Req() req: AuthedRequest) {
    return this.invoices.getInvoiceForCampaign(
      req.orgContext!.orgId,
      campaignId,
    );
  }

  @Patch(':campaignId')
  @RequireOrgRole('admin')
  update(
    @Param('campaignId') campaignId: string,
    @Body() body: CampaignDraftInput,
    @Req() req: AuthedRequest,
  ) {
    return this.campaigns.updateCampaign(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
      body ?? {},
    );
  }

  // PUT (not POST): the MVP campaign has exactly ONE gift option;
  // setting it replaces any previous choice.
  @Put(':campaignId/gift-option')
  @RequireOrgRole('admin')
  setGiftOption(
    @Param('campaignId') campaignId: string,
    @Body() body: { productId?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.campaigns.setGiftOption(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
      body?.productId,
    );
  }

  @Post(':campaignId/recipients')
  @RequireOrgRole('admin')
  addRecipients(
    @Param('campaignId') campaignId: string,
    @Body() body: { contactIds?: string[] },
    @Req() req: AuthedRequest,
  ) {
    return this.campaigns.addRecipients(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
      body?.contactIds,
    );
  }

  @Delete(':campaignId/recipients/:recipientId')
  @RequireOrgRole('admin')
  removeRecipient(
    @Param('campaignId') campaignId: string,
    @Param('recipientId') recipientId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.campaigns.removeRecipient(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
      recipientId,
    );
  }

  @Post(':campaignId/submit')
  @RequireOrgRole('admin')
  submit(@Param('campaignId') campaignId: string, @Req() req: AuthedRequest) {
    return this.campaigns.submitForApproval(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
    );
  }

  @Post(':campaignId/approve')
  @RequireOrgRole('approver')
  approve(@Param('campaignId') campaignId: string, @Req() req: AuthedRequest) {
    return this.campaigns.approveCampaign(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
    );
  }

  @Post(':campaignId/request-changes')
  @RequireOrgRole('approver')
  requestChanges(
    @Param('campaignId') campaignId: string,
    @Body() body: { note?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.campaigns.requestChanges(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
      body?.note,
    );
  }

  @Post(':campaignId/cancel')
  @RequireOrgRole('admin')
  cancel(@Param('campaignId') campaignId: string, @Req() req: AuthedRequest) {
    return this.campaigns.cancelCampaign(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
    );
  }

  // ── Dispatch (PR 4) ──────────────────────────────────────────────

  // Execute an approved campaign: enqueue one DispatchJob per
  // recipient. Admin-seat — the maker–checker gate sat at approval;
  // dispatch executes a decision already signed off.
  @Post(':campaignId/dispatch')
  @RequireOrgRole('admin')
  dispatchCampaign(
    @Param('campaignId') campaignId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.dispatch.dispatchCampaign(
      req.user.userId,
      req.orgContext!.orgId,
      campaignId,
    );
  }

  // Queue-health counts (pending/processing/dispatched/failed) —
  // operational data, not participation outcomes.
  @Get(':campaignId/dispatch-status')
  @RequireOrgRole('admin', 'approver')
  dispatchStatus(
    @Param('campaignId') campaignId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.dispatch.getDispatchStatus(
      req.orgContext!.orgId,
      campaignId,
    );
  }

  // ── Reporting (PR 6) ─────────────────────────────────────────────

  // The org-plane funnel report. ANY active seat may read it —
  // read-only reports are the viewer role's entire purpose. The
  // payload is aggregate counts only, with the F7 non-participation
  // collapse applied in ReportService; recipient identity never
  // appears here.
  @Get(':campaignId/report')
  @RequireOrgRole()
  report(@Param('campaignId') campaignId: string, @Req() req: AuthedRequest) {
    return this.reports.orgCampaignReport(req.orgContext!.orgId, campaignId);
  }
}
