import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../admin/admin.guard';
import {
  OpsRoleGuard,
  RequireOpsPermission,
} from '../ops-roles/ops-role.guard';
import { BetaAccessService } from './beta-access.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// /admin/beta/* — Closed Beta Gate administration.
//
// Triple-guarded exactly like AdminController: JwtAuthGuard populates
// req.user, AdminGuard rejects non-admins, OpsRoleGuard enforces the
// route-level @RequireOpsPermission('beta.manage'). Every route here
// carries the decorator, so a legacy admin with no ops-role grant gets
// a 403 — only super_admin + operations_manager hold beta.manage.
//
// NOTE: the gate ENFORCEMENT lives in AuthService.register (it consults
// BetaAccessService.decideRegistration). This controller is the
// operator surface for curating codes + the allowlist; it does NOT
// itself gate registration.
@Controller('admin/beta')
@UseGuards(JwtAuthGuard, AdminGuard, OpsRoleGuard)
@RequireOpsPermission('beta.manage')
export class BetaAccessController {
  constructor(private readonly beta: BetaAccessService) {}

  // Whether the master switch is currently ON. Lets the admin UI render
  // an accurate "gate is live / gate is off" banner without guessing.
  @Get('status')
  status() {
    return this.beta.getStatus();
  }

  // ── Invite codes ───────────────────────────────────────────────────

  @Get('codes')
  listCodes() {
    return this.beta.listCodes();
  }

  // Create a code. Omit `code` to auto-generate (QIFT-XXXX-XXXX).
  // `maxUses` null/omitted = unlimited; `expiresAt` null/omitted =
  // never expires.
  @Post('codes')
  createCode(
    @Body()
    body: {
      code?: string;
      label?: string;
      maxUses?: number | null;
      expiresAt?: string | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.beta.createCode(body ?? {}, req.user.userId);
  }

  @Patch('codes/:id/disable')
  disableCode(@Param('id') id: string) {
    return this.beta.setCodeDisabled(id, true);
  }

  @Patch('codes/:id/enable')
  enableCode(@Param('id') id: string) {
    return this.beta.setCodeDisabled(id, false);
  }

  // ── Allowlist ──────────────────────────────────────────────────────

  @Get('allowlist')
  listAllowlist() {
    return this.beta.listAllowlist();
  }

  // kind ∈ { 'email', 'email_domain', 'phone' }. `value` is normalised
  // server-side (lowercased email/domain, E.164 phone) before insert.
  @Post('allowlist')
  addAllowlistEntry(
    @Body() body: { kind: string; value: string; label?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.beta.addAllowlistEntry(body, req.user.userId);
  }

  @Delete('allowlist/:id')
  removeAllowlistEntry(@Param('id') id: string) {
    return this.beta.removeAllowlistEntry(id);
  }
}
