import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { StoreService } from './store.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { StoreGuard } from './store.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };
type ShipBody = {
  trackingNumber?: string;
  carrier?: string;
  // Stable provider code (smsa | aramex | dhl | spl | manual |
  // other). Optional for backwards compat — if omitted, no
  // Shipment row is created and the legacy carrier string is
  // the only record.
  provider?: string;
};
type ShipmentBody = { provider: string; trackingNumber?: string };
type ShipmentEventBody = {
  status: string;
  note?: string;
  occurredAt?: string;
};

// Order matters: JwtAuthGuard runs first so `req.user` is populated; then
// StoreGuard checks store ownership. Putting both at controller level
// means every route inherits the same protection.
@Controller('store')
@UseGuards(JwtAuthGuard, StoreGuard)
export class StoreController {
  constructor(private service: StoreService) {}

  // Track A.5 PR 8: ?q= searches by QF reference (case/dash-blind),
  // receiver name/username, product name, or carrier tracking number;
  // ?scope=history returns the PII-minimized completed-order view
  // (delivered + cancelled, no address fields).
  @Get('orders')
  listOrders(
    @Req() req: AuthedRequest,
    @Query('q') q?: string,
    @Query('scope') scope?: string,
  ) {
    return this.service.listOrders(req.user.userId, { q, scope });
  }

  // address_confirmed | default_address_used → preparing
  @Post('orders/:id/prepare')
  prepare(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.markPreparing(req.user.userId, id);
  }

  // preparing → shipped. Optional `provider` upgrades the Gift to
  // a structured Shipment row with a tracking deep-link; older
  // clients can keep posting just `trackingNumber` + `carrier`.
  @Post('orders/:id/ship')
  ship(
    @Param('id') id: string,
    @Body() body: ShipBody,
    @Req() req: AuthedRequest,
  ) {
    return this.service.markShipped(req.user.userId, id, {
      trackingNumber: body?.trackingNumber,
      carrier: body?.carrier,
      provider: body?.provider,
    });
  }

  // shipped → delivered (terminal, idempotent)
  @Post('orders/:id/delivered')
  delivered(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.markDelivered(req.user.userId, id);
  }

  // Read the structured Shipment + timeline. Returns
  //   { shipment: null, legacyTrackingNumber, legacyCarrier }
  // when no Shipment row has been created yet (legacy ship flow).
  @Get('orders/:id/shipment')
  getShipment(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.getShipmentForOrder(req.user.userId, id);
  }

  // Create or update the Shipment row out of band — used for
  // adding tracking after the fact, or upgrading a legacy carrier
  // string row to a structured Shipment.
  @Post('orders/:id/shipment')
  upsertShipment(
    @Param('id') id: string,
    @Body() body: ShipmentBody,
    @Req() req: AuthedRequest,
  ) {
    return this.service.upsertShipment(req.user.userId, id, body);
  }

  // Append a tracking event to the timeline.
  @Post('orders/:id/shipment/event')
  appendShipmentEvent(
    @Param('id') id: string,
    @Body() body: ShipmentEventBody,
    @Req() req: AuthedRequest,
  ) {
    return this.service.appendShipmentEvent(req.user.userId, id, body);
  }

  // ── Analytics + payouts ───────────────────────────────────
  // Aggregations over the merchant's Gift history. Privacy:
  // counts + revenue only; we never return any per-gift row
  // through this endpoint.
  @Get('analytics')
  analytics(@Req() req: AuthedRequest) {
    return this.service.getAnalytics(req.user.userId);
  }

  // Mock payout breakdown derived from delivered orders. Real
  // gateway settlement is future work — this surfaces the
  // calculated net so the merchant can verify the math.
  @Get('payouts')
  payouts(@Req() req: AuthedRequest) {
    return this.service.getPayouts(req.user.userId);
  }

  // Provider catalog. Frontend uses this to render the dropdown
  // in the Add-tracking modal. Public-ish (any merchant role) —
  // it's not sensitive data.
  @Get('shipping-providers')
  shippingProviders() {
    return this.service.listShippingProviders();
  }
}
