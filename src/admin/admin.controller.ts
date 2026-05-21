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
import { AdminService, type AdminSandboxModeFilter } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminGuard } from './admin.guard';
import { OpsRolesService } from '../ops-roles/ops-roles.service';
import {
  OpsRoleGuard,
  RequireOpsPermission,
} from '../ops-roles/ops-role.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Every /admin/* route is triple-guarded: JwtAuthGuard populates
// req.user, AdminGuard re-loads the role from the DB and rejects
// any non-admin, then OpsRoleGuard reads route-level
// @RequireOpsPermission(...) metadata (when present) and rejects
// admins whose ops-role assignments don't cover the requested
// permission. Routes WITHOUT the decorator behave exactly as
// before (admin-only); new gated routes opt in to the granular
// layer one decorator at a time.
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard, OpsRoleGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly opsRoles: OpsRolesService,
  ) {}

  // ── Users ────────────────────────────────────────────────────────

  @Get('users')
  listUsers(@Query('q') q?: string) {
    return this.admin.listUsers(q);
  }

  // Week 2 hardening — state-changing role assignment requires the
  // narrowest available ops permission. Currently granted only to
  // super_admin (PERMISSIONS_BY_ROLE in ops-roles.ts has no other
  // role holding 'user.set_role'); a legacy admin without any ops
  // grant now gets a 403 'Operation requires elevated permissions'
  // instead of being able to silently promote arbitrary users.
  @Patch('users/:id/role')
  @RequireOpsPermission('user.set_role')
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

  // Week 2 hardening — store status mutation requires 'store.set_status'.
  // Granted to super_admin + operations_manager + merchant_review +
  // trust_safety. Roles without it (finance, support, fulfillment_ops,
  // analytics_viewer) can no longer flip store visibility.
  @Patch('stores/:id/status')
  @RequireOpsPermission('store.set_status')
  setStoreStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.admin.setStoreStatus(id, body?.status ?? '');
  }

  // Onboarding-v2 review action with operator note. Distinct from the
  // raw status PATCH above — this one validates the action set
  // (approve / reject / request_changes), enforces a non-empty
  // reason for the two negative branches, and records reviewedAt /
  // reviewedBy for the audit trail.
  //
  // Week 2 hardening — the review action requires the dedicated
  // 'store.review' ops permission. Granted to super_admin +
  // operations_manager + merchant_review.
  @Patch('stores/:id/review')
  @RequireOpsPermission('store.review')
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

  // Admin-only plan assignment. Merchants don't self-upgrade; the
  // admin moves them between starter / pro / enterprise manually.
  // Body: { plan: 'starter' | 'pro' | 'enterprise' }. See
  // apps/api/src/stores/merchant-plans.ts for the capability map.
  @Patch('stores/:id/plan')
  @RequireOpsPermission('store.set_plan')
  setStorePlan(@Param('id') id: string, @Body() body: { plan?: string }) {
    return this.admin.setStorePlan(id, body?.plan ?? '');
  }

  // Marketplace featured toggle. Drives the /stores "Featured"
  // rail. Idempotent — re-applying the same value no-ops.
  @Patch('stores/:id/featured')
  @RequireOpsPermission('store.set_featured')
  setStoreFeatured(
    @Param('id') id: string,
    @Body() body: { featured?: boolean },
  ) {
    return this.admin.setStoreFeatured(id, body?.featured === true);
  }

  // ── Ops roles (RBAC) ──────────────────────────────────────
  //
  // Granular permission layer on top of User.role = 'admin'.
  // Only admins can hold ops roles; promoting a non-admin user
  // is rejected by OpsRolesService.grant. Capability map lives
  // in apps/api/src/ops-roles/ops-roles.ts — never hardcode role
  // checks at call sites.

  @Get('users/:id/ops-roles')
  @RequireOpsPermission('user.read')
  listUserOpsRoles(@Param('id') id: string) {
    return this.opsRoles.listAssignments(id);
  }

  @Post('users/:id/ops-roles')
  @RequireOpsPermission('user.assign_ops_role')
  grantOpsRole(
    @Param('id') id: string,
    @Body() body: { role?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.opsRoles.grant(req.user.userId, id, body?.role ?? '');
  }

  @Patch('users/:id/ops-roles/revoke')
  @RequireOpsPermission('user.assign_ops_role')
  revokeOpsRole(@Param('id') id: string, @Body() body: { role?: string }) {
    return this.opsRoles.revoke(id, body?.role ?? '');
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

  // Closed-beta sandbox tab. `?mode=sandbox|live|all`; defaults to
  // 'all' so the existing admin gift-list view is unchanged during
  // closed beta (every row is sandbox anyway). The frontend renders
  // a TEST chip per row on the 'all' view using AdminGiftRow.isSandbox.
  @Get('gifts')
  listGifts(@Query('mode') mode?: string) {
    return this.admin.listGifts(parseSandboxMode(mode, 'all'));
  }

  // ── Reports ──────────────────────────────────────────────────────

  @Get('reports')
  listReports() {
    return this.admin.listReports();
  }

  // Week 2 hardening — report-resolution mutation requires the
  // 'report.resolve' ops permission. Granted to super_admin +
  // trust_safety. Other admins can still LIST reports
  // (GET /admin/reports has no decorator), but only T&S operators
  // can change their status.
  @Patch('reports/:id/status')
  @RequireOpsPermission('report.resolve')
  setReportStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.admin.setReportStatus(id, body?.status ?? '');
  }

  // ── System ───────────────────────────────────────────────────────

  @Get('system')
  systemStatus() {
    return this.admin.getSystemStatus();
  }

  // ── Global ops search ──────────────────────────────────────────
  //
  // Quick-jump search across users / stores / gifts. Gated behind
  // `diagnostics.read` so support + ops roles get access without
  // a separate per-resource permission.
  @Get('search')
  @RequireOpsPermission('diagnostics.read')
  search(@Query('q') q?: string) {
    return this.admin.opsSearch(q ?? '');
  }

  // ── Finance operations ─────────────────────────────────────────
  //
  // Per-store payout balances + event log. All gated behind
  // `finance.read_payouts` (read) / `finance.record_payout_event`
  // (write). Operators without these permissions can't reach
  // any of the finance surfaces — the frontend hides the tab
  // entirely, but the server-side gate is authoritative.

  // Closed-beta sandbox filter. `?mode=sandbox|live|all`; defaults
  // to 'live' — real-money balance totals MUST never include
  // sandbox events by accident. Operators viewing test ledger
  // activity opt in explicitly with mode=sandbox.
  @Get('finance/stores')
  @RequireOpsPermission('finance.read_payouts')
  financeStoreBalances(@Query('mode') mode?: string) {
    return this.admin.financeStoreBalances(parseSandboxMode(mode, 'live'));
  }

  @Get('finance/stores/:id/events')
  @RequireOpsPermission('finance.read_payouts')
  financeStoreEvents(@Param('id') id: string) {
    return this.admin.financeStoreEvents(id);
  }

  @Post('finance/stores/:id/events')
  @RequireOpsPermission('finance.record_payout_event')
  recordFinanceEvent(
    @Param('id') id: string,
    @Body()
    body: {
      type?: string;
      amount?: number;
      currency?: string;
      reason?: string;
      giftId?: string;
      occurredAt?: string;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.admin.recordPayoutEvent(req.user.userId, id, body);
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

  // ── Seed verification + on-demand merchant seed ────────────────
  //
  // Production deploy of merchant onboarding v2 doesn't auto-run
  // the prisma seed script — Railway only chains `prisma migrate
  // deploy` on `start:migrate`. So the new schema lands but the
  // two test merchants (merchant.riyadh.flowers + merchant.gcc.
  // perfumes) don't exist in production.
  //
  // These two endpoints close the gap:
  //   GET  /admin/debug/seed-status     → tells you what's missing
  //   POST /admin/debug/seed-merchants  → seeds the two test
  //                                       merchants (idempotent;
  //                                       safe to call multiple
  //                                       times)
  //
  // Both are admin-guarded by the controller-level @UseGuards.
  // Privacy-safe: no PII in responses (just usernames + counts).

  @Get('debug/seed-status')
  debugSeedStatus() {
    return this.admin.debugSeedStatus();
  }

  // Week 2 hardening — seeding is a state-changing diagnostic
  // operation; protect with 'diagnostics.run_seed'. Granted to
  // super_admin + operations_manager. The read-only counterpart
  // GET /admin/debug/seed-status remains undecorated (admin-only
  // by the controller-level AdminGuard).
  @Post('debug/seed-merchants')
  @RequireOpsPermission('diagnostics.run_seed')
  debugSeedMerchants(@Req() req: AuthedRequest) {
    return this.admin.debugSeedMerchants(req.user.userId);
  }
}

// Coerce the raw query-string value to the three-state filter. Any
// unrecognised value falls back to `fallback`; the caller chooses
// the safe default per route (gift-list defaults to 'all', finance
// defaults to 'live').
function parseSandboxMode(
  raw: string | undefined,
  fallback: AdminSandboxModeFilter,
): AdminSandboxModeFilter {
  if (raw === 'sandbox' || raw === 'live' || raw === 'all') return raw;
  return fallback;
}
