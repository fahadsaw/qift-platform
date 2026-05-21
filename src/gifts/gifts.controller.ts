import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
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

  // Week 2 — POST /gifts supports an optional `Idempotency-Key`
  // header. Same (senderId, key, payload) replays return the
  // original gift + `Idempotent-Replayed: true` response header.
  // Same key + DIFFERENT payload returns 409 idempotency_key_reused.
  // No header at all behaves exactly like before (no dedup
  // tracking; both DB columns NULL). See GiftsService.create for
  // the full behaviour matrix.
  @Post()
  async create(
    @Body() body: CreateGiftInput,
    @Req() req: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The body's senderId (if any) is intentionally ignored — sender is the
    // authenticated viewer.
    const result = await this.service.create(
      body,
      req.user.userId,
      idempotencyKey ?? null,
    );
    if (result.replayed) {
      // Surface the replay signal to the client (and to anything
      // observing the response, e.g. operator log tooling).
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return result.gift;
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

  // Sender-facing self-cancel was deliberately removed.
  //
  // Once a gift has been purchased the buyer cannot cancel it through
  // the app: that flow is too easy to abuse, disrupts the merchant
  // mid-fulfilment, and pushes refund complexity onto support without
  // a real audit trail. Cancellation is an admin / support operation
  // — when that surface lands it should expose a separate
  // /admin/gifts/:id/cancel route, not this one.
  //
  // GiftsService.cancel + the `cancelled` status + frontend rendering
  // for already-cancelled gifts all stay in place so admin tooling
  // can call it later without touching the state machine.

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
