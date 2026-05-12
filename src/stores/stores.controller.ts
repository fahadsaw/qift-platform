import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  StoresService,
  type CreateStoreInput,
  type UpdateStoreInput,
} from './stores.service';

type AuthedRequest = { user?: { userId: string; qiftUsername: string } };

// Two route shapes:
//   - List + detail are public (anyone can browse the storefront).
//   - Create + update + listMine require a valid JWT.
// Each handler enforces the right gate inline so we don't accidentally
// inherit a wrong default at controller scope.
@Controller('stores')
export class StoresController {
  constructor(private service: StoresService) {}

  @Get()
  list() {
    return this.service.list();
  }

  // Stores owned by the JWT viewer. Comes BEFORE the :id route so Nest
  // doesn't try to bind "me" as the id param.
  @Get('me')
  @UseGuards(JwtAuthGuard)
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user!.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() body: CreateStoreInput, @Req() req: AuthedRequest) {
    return this.service.create(req.user!.userId, body);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @Body() body: UpdateStoreInput,
    @Req() req: AuthedRequest,
  ) {
    // Onboarding-v2: route owner-side updates through `patch` which
    // accepts every business field + zones. The legacy `update`
    // method (name/city/category only) stays for backwards compat
    // with any caller that hasn't migrated to the wider input
    // shape — callers that send the new fields use the same body
    // and the service narrows internally.
    return this.service.patch(req.user!.userId, id, body);
  }

  // Owner-side detail with the richer projection (status,
  // rejectionReason, zones, etc.). Used by the merchant pending-
  // approval screen + the multi-step onboarding form's resume
  // mode. Controller-level guard is just JWT; ownership / admin
  // is enforced inside the service via STORE_USER_IDS or owner
  // match.
  @Get(':id/owner')
  @UseGuards(JwtAuthGuard)
  findOneForOwner(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.findOneForOwnerOrAdmin(req.user!.userId, id);
  }

  // Submit a draft / changes-requested merchant application for
  // admin review. Service enforces the allowed source statuses.
  @Post(':id/submit')
  @UseGuards(JwtAuthGuard)
  submit(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.submit(req.user!.userId, id);
  }

  // ── Storefront theme (Phase 5) ──────────────────────────────
  //
  // Update the store's selected theme + bounded branding overrides.
  // Service enforces ownership + plan-gating + config sanitization.
  // The dashboard theme picker is the intended caller.
  @Patch(':id/theme')
  @UseGuards(JwtAuthGuard)
  setTheme(
    @Param('id') id: string,
    @Body() body: { themeSlug?: string; themeConfig?: unknown },
    @Req() req: AuthedRequest,
  ) {
    return this.service.setStoreTheme(req.user!.userId, id, body);
  }

  // Update per-metric publicity flags. Same opt-in pattern as the
  // user-side preferencesVisibility — every key defaults to false
  // (owner-only). The visibility dashboard is the intended caller.
  @Patch(':id/visibility')
  @UseGuards(JwtAuthGuard)
  setVisibility(
    @Param('id') id: string,
    @Body() body: { metricsVisibility?: Record<string, boolean> | null },
    @Req() req: AuthedRequest,
  ) {
    return this.service.setStoreMetricsVisibility(
      req.user!.userId,
      id,
      body.metricsVisibility,
    );
  }
}
