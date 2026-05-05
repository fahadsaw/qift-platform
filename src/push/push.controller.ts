import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PushService, type SubscribeInput } from './push.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };
type UnsubscribeBody = { endpoint?: string };

@Controller('push')
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private service: PushService) {}

  // Save / update the calling browser's subscription for the JWT viewer.
  // Body shape mirrors the standard PushSubscription.toJSON() output, so
  // the frontend can pass `subscription.toJSON()` straight through with
  // an optional userAgent on top.
  @Post('subscribe')
  async subscribe(@Body() body: SubscribeInput, @Req() req: AuthedRequest) {
    const sub = await this.service.subscribe(req.user.userId, body);
    return { ok: true, subscription: sub };
  }

  // Remove a subscription by endpoint. Scoped to the JWT viewer so a
  // malicious client can't unsubscribe someone else's device just by
  // knowing the endpoint URL.
  @Delete('unsubscribe')
  unsubscribe(@Body() body: UnsubscribeBody, @Req() req: AuthedRequest) {
    return this.service.unsubscribe(req.user.userId, body?.endpoint ?? '');
  }

  // Whether the viewer currently has any active subscriptions and
  // whether the server even has VAPID configured. The settings UI uses
  // both bits to decide which CTA to render.
  @Get('status')
  status(@Req() req: AuthedRequest) {
    return this.service.status(req.user.userId);
  }
}
