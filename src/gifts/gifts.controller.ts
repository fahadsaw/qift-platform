import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { GiftsService, type CreateGiftInput } from './gifts.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

type ConfirmAddressBody = { addressId?: string };

// Every gift route requires a valid JWT. Ownership checks live in the service
// layer so they apply regardless of how the route is reached.
@Controller('gifts')
@UseGuards(JwtAuthGuard)
export class GiftsController {
  constructor(private service: GiftsService) {}

  @Post()
  create(@Body() body: CreateGiftInput, @Req() req: AuthedRequest) {
    // The body's senderId (if any) is intentionally ignored — sender is the
    // authenticated viewer.
    return this.service.create(body, req.user.userId);
  }

  // Receiver confirms the delivery address. Optional `addressId` lets them
  // pick a non-default address; otherwise the service falls back to default.
  @Post(':id/confirm-address')
  confirmAddress(
    @Param('id') id: string,
    @Body() body: ConfirmAddressBody,
    @Req() req: AuthedRequest,
  ) {
    return this.service.confirmAddress(id, req.user.userId, body?.addressId);
  }

  // Sender-only. Cancel a gift before the store has accepted it
  // (status in pending_address / address_confirmed / default_address_used).
  // Idempotent: a second call on an already-cancelled gift returns the
  // current snapshot. See GiftsService.cancel for the state-machine
  // rules and the receiver-side notification.
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.cancel(id, req.user.userId);
  }

  // Note: a `mark-delivered` route used to live here for either party to
  // flip a gift to delivered. v3 makes delivery store-driven (POST
  // /store/orders/:id/delivered), so the user-facing route was removed to
  // keep transitions strict.

  // Note: a global `GET /gifts` route used to live here. It was removed
  // because it returned every gift in the system to any authenticated
  // user — including their messages, media, and addresses. Use the
  // scoped per-user routes below instead. No frontend caller relied on
  // it.

  @Get('sent/:senderId')
  findSent(@Param('senderId') senderId: string, @Req() req: AuthedRequest) {
    return this.service.findSent(senderId, req.user.userId);
  }

  @Get('received/:receiverId')
  findReceived(
    @Param('receiverId') receiverId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.service.findReceived(receiverId, req.user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.findOne(id, req.user.userId);
  }
}
