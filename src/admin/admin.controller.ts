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
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminGuard } from './admin.guard';
import { OpsRolesService } from '../ops-roles/ops-roles.service';
import { permissionsFor } from '../ops-roles/ops-roles';
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

  // ── Self ─────────────────────────────────────────────────────────

  // GET /admin/me/ops-roles — self-introspection for the admin UI
  // (PR 10, permission-aware rendering). Returns the viewer's ops
  // roles AND the server-computed effective permission set, so the
  // frontend never re-derives role→permission mappings from its own
  // catalog copy (catalog drift between the two would silently show
  // or hide the wrong buttons). No @RequireOpsPermission: any admin
  // may ask what THEY can do — this reveals nothing about others.
  // Purely advisory for rendering; every mutation stays guarded
  // server-side regardless of what the UI shows.
  @Get('me/ops-roles')
  async myOpsRoles(@Req() req: AuthedRequest) {
    const roles = await this.opsRoles.getUserRoles(req.user.userId);
    return { roles, permissions: [...permissionsFor(roles)] };
  }

  // GET /admin/audit-log — read-only audit viewer (PR 11). Newest
  // first; filter by exact actor id, action prefix, target type;
  // page older with ?before=<ISO timestamp>. Gated by audit.read
  // (super_admin / operations_manager / trust_safety) because
  // metadata can carry contact-change forensics.
  @Get('audit-log')
  @RequireOpsPermission('audit.read')
  listAuditLog(
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('before') before?: string,
    @Query('take') take?: string,
  ) {
    return this.admin.listAuditLog({
      actor,
      action,
      targetType,
      before,
      take: take ? Number(take) : undefined,
    });
  }

  // ── Users ────────────────────────────────────────────────────────

  @Get('users')
  listUsers(
    @Query('q') q?: string,
    // `?includeDisabled=1` surfaces soft-deleted rows so the
    // operator can find restore candidates. Default remains
    // "active only" — the regular browse view stays free of
    // disabled noise.
    @Query('includeDisabled') includeDisabled?: string,
  ) {
    return this.admin.listUsers(q, {
      includeDisabled: includeDisabled === '1' || includeDisabled === 'true',
    });
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

  // Soft-delete (disable) a user. Sets User.deletedAt = now() so
  // the row is filtered from search, login, public profile, and
  // the default admin browse list — but the record is preserved
  // for restore + regulatory audit.
  //
  // Permission: `user.suspend` (super_admin + trust_safety).
  // Self-disable is rejected at the service layer (another admin
  // must do it — same posture as setUserRole self-demote).
  //
  // Audit trail: every disable writes an AuditLog row with the
  // actor + target ids and the priorRole at disable time.
  @Patch('users/:id/disable')
  @RequireOpsPermission('user.suspend')
  disableUser(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.admin.softDeleteUser(req.user.userId, id);
  }

  // Restore a soft-deleted user. Clears `deletedAt` so the row
  // becomes active again with every other column (phone, email,
  // role, etc.) preserved exactly as it was at disable time.
  //
  // Permission: `user.restore` (new — super_admin + trust_safety).
  // Restoring an already-active user is rejected as
  // `user_not_disabled` rather than silently succeeding so a
  // misclick doesn't look like a successful operation.
  @Patch('users/:id/restore')
  @RequireOpsPermission('user.restore')
  restoreUser(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.admin.restoreUser(req.user.userId, id);
  }

  // Permanently delete (purge) a user account. Distinct from
  // /disable: this is the GDPR-style "right to be forgotten with
  // regulatory preservation" pattern. See admin.service.ts
  // purgeUser() for the full anonymisation + retention contract.
  //
  // Permission: `user.purge` — NEW, super_admin ONLY. Body
  // requires `confirmUsername` matching the target's current
  // qiftUsername exactly; the frontend forces the operator to
  // type the value, the backend re-checks because a tampered
  // client could bypass the UI gate.
  //
  // Pre-purge guards (in order, see service for exact codes):
  //   viewer == target          → 403 cannot_purge_self
  //   target.role == 'admin'    → 403 cannot_purge_admin
  //   target owns ≥ 1 store     → 409 user_owns_stores
  //   target has in-flight gifts→ 409 user_has_inflight_gifts
  //   confirmUsername mismatch  → 400 confirmation_mismatch
  //
  // Idempotent: a second purge on an already-purged row returns
  // the existing purgedAt without re-running the transaction.
  @Patch('users/:id/purge')
  @RequireOpsPermission('user.purge')
  purgeUser(
    @Param('id') id: string,
    @Body() body: { confirmUsername?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.admin.purgeUser(
      req.user.userId,
      id,
      body?.confirmUsername ?? '',
    );
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
  setStoreStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.admin.setStoreStatus(req.user.userId, id, body?.status ?? '');
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
  setStorePlan(
    @Param('id') id: string,
    @Body() body: { plan?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.admin.setStorePlan(req.user.userId, id, body?.plan ?? '');
  }

  // Marketplace featured toggle. Drives the /stores "Featured"
  // rail. Idempotent — re-applying the same value no-ops.
  @Patch('stores/:id/featured')
  @RequireOpsPermission('store.set_featured')
  setStoreFeatured(
    @Param('id') id: string,
    @Body() body: { featured?: boolean },
    @Req() req: AuthedRequest,
  ) {
    return this.admin.setStoreFeatured(
      req.user.userId,
      id,
      body?.featured === true,
    );
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
  revokeOpsRole(
    @Param('id') id: string,
    @Body() body: { role?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.opsRoles.revoke(req.user.userId, id, body?.role ?? '');
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

  @Get('finance/stores')
  @RequireOpsPermission('finance.read_payouts')
  financeStoreBalances() {
    return this.admin.financeStoreBalances();
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
