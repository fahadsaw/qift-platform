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
}
