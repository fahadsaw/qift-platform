import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminGuard } from './admin.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Every /admin/* route is double-guarded: JwtAuthGuard populates
// req.user, then AdminGuard re-loads the role from the DB and
// rejects any non-admin. Service methods take the viewer's userId so
// future audit logging can attribute mutations.
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── Users ────────────────────────────────────────────────────────

  @Get('users')
  listUsers(@Query('q') q?: string) {
    return this.admin.listUsers(q);
  }

  @Patch('users/:id/role')
  setUserRole(
    @Param('id') id: string,
    @Body() body: { role?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.admin.setUserRole(req.user.userId, id, body?.role ?? '');
  }

  // ── Stores ───────────────────────────────────────────────────────

  @Get('stores')
  listStores(@Query('q') q?: string) {
    return this.admin.listStores(q);
  }

  @Patch('stores/:id/status')
  setStoreStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.admin.setStoreStatus(id, body?.status ?? '');
  }

  // Onboarding-v2 review action with operator note. Distinct from the
  // raw status PATCH above — this one validates the action set
  // (approve / reject / request_changes), enforces a non-empty
  // reason for the two negative branches, and records reviewedAt /
  // reviewedBy for the audit trail.
  @Patch('stores/:id/review')
  reviewStore(
    @Param('id') id: string,
    @Body() body: { action?: string; reason?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.admin.reviewStore(
      req.user.userId,
      id,
      (body?.action as 'approve' | 'reject' | 'request_changes') ?? '',
      body?.reason ?? null,
    );
  }

  // Owner-or-admin detail. Returns the rich projection (with
  // rejectionReason, zones, contact info, etc.) for the review
  // modal so the admin can render every onboarding field.
  @Get('stores/:id/detail')
  storeDetail(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.admin.storeDetail(req.user.userId, id);
  }

  // Documents uploaded with the merchant application. Listed for
  // the admin review modal. The response carries fileUrl pointers
  // to R2 — the admin browser fetches them on click. No payloads
  // ride this list response itself.
  @Get('stores/:id/documents')
  storeDocuments(@Param('id') id: string) {
    return this.admin.listStoreDocuments(id);
  }

  // ── Gifts ────────────────────────────────────────────────────────

  @Get('gifts')
  listGifts() {
    return this.admin.listGifts();
  }

  // ── Reports ──────────────────────────────────────────────────────

  @Get('reports')
  listReports() {
    return this.admin.listReports();
  }

  @Patch('reports/:id/status')
  setReportStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.admin.setReportStatus(id, body?.status ?? '');
  }

  // ── System ───────────────────────────────────────────────────────

  @Get('system')
  systemStatus() {
    return this.admin.getSystemStatus();
  }

  // ── Diagnostics ─────────────────────────────────────────────────
  //
  // Production-grade lineage inspector. Used to debug "merchant
  // doesn't see this order" reports. Returns the full chain
  // Order → Gift → Product → Store → owner — alongside an
  // explicit "would /store/orders return this for the owner?"
  // verdict with a reason string.
  //
  // Privacy: no recipient address, no message text, no media.
  // Identifiers + status fields only. Admin-only by guard above.
  //
  // Use:
  //   GET /admin/diagnose/gift/latest          (most recent gift)
  //   GET /admin/diagnose/gift/<giftId>        (specific gift)

  @Get('diagnose/gift/latest')
  diagnoseLatestGift() {
    return this.admin.diagnoseLatestGift();
  }

  @Get('diagnose/gift/:id')
  diagnoseGift(@Param('id') id: string) {
    return this.admin.diagnoseGift(id);
  }

  // ── Browser-friendly debug endpoint ────────────────────────────
  //
  // Single-URL diagnostic for "merchant doesn't see this order"
  // reports. Returns:
  //   - the latest Order (full lineage)
  //   - the latest Gift (full lineage)
  //   - whether they're the same operational unit (i.e. the
  //     order's giftId points to the gift)
  //   - a verdict on whether the latest gift would appear on
  //     the merchant dashboard
  //   - optional ?merchant=<qiftUsername> ownership check
  //
  // Use:
  //   GET /admin/debug/latest-merchant-order
  //   GET /admin/debug/latest-merchant-order?merchant=<username>
  //
  // PRIVACY: identifiers + status fields only. NO recipient
  // address, NO message text, NO media, NO secrets. Safe to
  // paste into a support thread.

  @Get('debug/latest-merchant-order')
  debugLatestMerchantOrder(@Query('merchant') merchant?: string) {
    return this.admin.debugLatestMerchantOrder(merchant);
  }
}
