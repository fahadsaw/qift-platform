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
  setStoreStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
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
  setReportStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    return this.admin.setReportStatus(id, body?.status ?? '');
  }

  // ── System ───────────────────────────────────────────────────────

  @Get('system')
  systemStatus() {
    return this.admin.getSystemStatus();
  }
}
