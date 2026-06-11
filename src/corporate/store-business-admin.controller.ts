import {
  Body,
  Controller,
  Get,
  Param,
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
import { StoreBusinessService } from './store-business.service';
import type { BusinessReviewAction } from './store-business.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// /admin/stores-business/* — Qift Business eligibility review (B1).
//
// Triple-guarded like every admin surface, gated by the existing
// store.review permission (operations_manager + merchant_review +
// super_admin): business vetting is merchant review work. A
// dedicated permission can be minted when a dedicated team exists.
//
// SEPARATE pipeline by design: nothing here reads or writes
// Store.status — approving a store for consumers never grants
// business access, and business suspension never touches the
// consumer storefront. B1 is ops-initiated end to end (concierge
// pilot); merchant self-serve apply is B5, gated behind Pilot #1.
@Controller('admin/stores-business')
@UseGuards(JwtAuthGuard, AdminGuard, OpsRoleGuard)
@RequireOpsPermission('store.review')
export class StoreBusinessAdminController {
  constructor(private readonly business: StoreBusinessService) {}

  // Review queue. ?status=applied is the default operator view.
  @Get()
  list(@Query('status') status?: string) {
    return this.business.list(status);
  }

  @Get(':storeId')
  get(@Param('storeId') storeId: string) {
    return this.business.get(storeId);
  }

  // Ops files the application on the merchant's behalf (concierge).
  // Requires the store to be consumer-approved first.
  @Post(':storeId/apply')
  apply(@Param('storeId') storeId: string, @Req() req: AuthedRequest) {
    return this.business.apply(req.user.userId, storeId);
  }

  // action ∈ { approve, reject, suspend, reinstate }; reject and
  // suspend require a reason (shown to the merchant verbatim).
  @Post(':storeId/review')
  review(
    @Param('storeId') storeId: string,
    @Body() body: { action: BusinessReviewAction; reason?: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.business.review(
      req.user.userId,
      storeId,
      body?.action as BusinessReviewAction,
      body?.reason ?? null,
    );
  }
}
