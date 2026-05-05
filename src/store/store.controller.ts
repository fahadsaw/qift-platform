import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { StoreService } from './store.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { StoreGuard } from './store.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };
type ShipBody = { trackingNumber?: string; carrier?: string };

// Order matters: JwtAuthGuard runs first so `req.user` is populated; then
// StoreGuard checks store ownership. Putting both at controller level
// means every route inherits the same protection.
@Controller('store')
@UseGuards(JwtAuthGuard, StoreGuard)
export class StoreController {
  constructor(private service: StoreService) {}

  @Get('orders')
  listOrders(@Req() req: AuthedRequest) {
    return this.service.listOrders(req.user.userId);
  }

  // address_confirmed | default_address_used → preparing
  @Post('orders/:id/prepare')
  prepare(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.markPreparing(req.user.userId, id);
  }

  // preparing → shipped
  @Post('orders/:id/ship')
  ship(
    @Param('id') id: string,
    @Body() body: ShipBody,
    @Req() req: AuthedRequest,
  ) {
    return this.service.markShipped(req.user.userId, id, {
      trackingNumber: body?.trackingNumber,
      carrier: body?.carrier,
    });
  }

  // shipped → delivered (terminal, idempotent)
  @Post('orders/:id/delivered')
  delivered(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.markDelivered(req.user.userId, id);
  }
}
