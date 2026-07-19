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
import { AdminGuard } from '../admin/admin.guard';
import {
  OpsRoleGuard,
  RequireOpsPermission,
} from '../ops-roles/ops-role.guard';
import { OrgService } from './org.service';
import type { OrgReviewAction } from './org.service';
import { ReportService } from './report.service';
import { ClaimExportService } from './claim-export.service';
import { FulfillmentExportService } from './fulfillment-export.service';
import { CampaignService } from './campaign.service';
import { MerchantInvoiceService } from './merchant-invoice.service';

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
  constructor(
    private readonly orgs: OrgService,
    private readonly reports: ReportService,
    private readonly claimExport: ClaimExportService,
    private readonly fulfillmentExport: FulfillmentExportService,
    private readonly campaigns: CampaignService,
    private readonly merchantInvoices: MerchantInvoiceService,
  ) {}

  // Attach the merchant's legal invoice reference (Track A.5 PR 5).
  // Agent model: records what the merchant/connector supplies (or a
  // contractually authorized on-behalf issuance) — Qift never
  // manufactures this number. Literal segment, declared before :orgId.
  @Patch('merchant-invoices/:invoiceId/legal-reference')
  attachMerchantInvoiceReference(
    @Param('invoiceId') invoiceId: string,
    @Body()
    body: {
      merchantInvoiceNumber?: string;
      merchantInvoiceExternalId?: string;
      merchantInvoiceUrl?: string;
      source?: string;
      onBehalfAuthorizationRef?: string;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.merchantInvoices.attachLegalReference(
      req.user.userId,
      invoiceId,
      body,
    );
  }

  // Support lookup by QG reference (Track A.5 PR 3): resolves what a
  // recipient or merchant quoted, WITHOUT rotating anything. Declared
  // before the :orgId routes so the literal segment wins the match.
  @Get('claims/by-reference/:reference')
  lookupClaim(
    @Param('reference') reference: string,
    @Req() req: AuthedRequest,
  ) {
    return this.fulfillmentExport.lookupClaimByReference(
      req.user.userId,
      reference,
    );
  }

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

  // Ops campaign list for one org (admin-screens enabler): the same
  // counts-only projection the org plane sees — ops picks a campaign
  // here to open its report or export claim links. An unknown orgId
  // simply returns [] (org-scoped where clause); the org queue is
  // the discovery surface, not this.
  @Get(':orgId/campaigns')
  listOrgCampaigns(@Param('orgId') orgId: string) {
    return this.campaigns.listCampaigns(orgId);
  }

  // Ops-plane campaign report (PR 6): full per-status granularity —
  // ops needs `mismatch` to chase roster errors and `failed` jobs to
  // unblock dispatch. Counts only; identities never appear even
  // here. The F7 collapse applies to the ORG plane, not this one.
  @Get(':orgId/campaigns/:campaignId/report')
  campaignReport(
    @Param('orgId') orgId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.reports.adminCampaignReport(orgId, campaignId);
  }

  // Claim-link export (PR 7b) — the manual-share distribution list.
  // POST, not GET: every call ROTATES the pending claims' tokens
  // (export IS the distribution event; prior links die). Gated by
  // the class-level org.review permission like everything here, and
  // audited with counts. Payload: contactName + channel + claimUrl
  // only — never channel values, never addresses.
  @Post(':orgId/campaigns/:campaignId/claim-links')
  exportClaimLinks(
    @Param('orgId') orgId: string,
    @Param('campaignId') campaignId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.claimExport.exportCampaignClaimLinks(
      req.user.userId,
      orgId,
      campaignId,
    );
  }

  // Fulfillment export (Track A5 / PE-06) — the audited delivery
  // sheet. OPS PLANE ONLY: ClaimAddress stays invisible to the org
  // plane (employer-blind invariant); this is the single sanctioned
  // read path, replacing raw SQL against production. Claimed rows
  // only; audit carries counts, never addresses. POST for parity
  // with the claim-link export — PII payloads don't belong on
  // cacheable GETs (though this one, unlike claim-links, mutates
  // nothing and is safe to repeat).
  @Post(':orgId/campaigns/:campaignId/fulfillment-export')
  exportFulfillment(
    @Param('orgId') orgId: string,
    @Param('campaignId') campaignId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.fulfillmentExport.exportCampaignFulfillment(
      req.user.userId,
      orgId,
      campaignId,
    );
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
