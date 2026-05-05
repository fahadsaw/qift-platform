import {
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  StoreIntegrationsService,
  type ConnectInput,
  type SyncInput,
} from './store-integrations.service';

type AuthedRequest = { user?: { userId: string; qiftUsername: string } };

type WebhookBody = { storeId?: string };

@Controller('store-integrations')
export class StoreIntegrationsController {
  constructor(private service: StoreIntegrationsService) {}

  // Connect a store to an upstream platform. Returns the freshly-minted
  // webhook secret ONCE — caller must persist it. JWT-required.
  @Post('connect')
  @UseGuards(JwtAuthGuard)
  connect(@Body() body: ConnectInput, @Req() req: AuthedRequest) {
    return this.service.connect(req.user!.userId, body);
  }

  // Trigger a product sync for a connected store. JWT-required +
  // ownership re-checked in the service.
  @Post('sync-products')
  @UseGuards(JwtAuthGuard)
  syncProducts(@Body() body: SyncInput, @Req() req: AuthedRequest) {
    return this.service.syncProducts(req.user!.userId, body);
  }

  // Webhook receiver. NOT JWT-guarded — upstream platforms authenticate
  // via the HMAC signature in the `X-Qift-Signature` header (verified in
  // the service against the store's saved webhookSecret). The storeId
  // comes from the body so the upstream can address any store it owns.
  @Post('webhook')
  webhook(
    @Body() body: WebhookBody,
    @Headers('x-qift-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    // We need the raw body string to reproduce the HMAC the sender used.
    // Express stores it on `req.rawBody` when `bodyParser` is configured
    // with `verify`; if it's not available we fall back to a JSON
    // re-stringify — same bytes for well-behaved senders, but cryptographic
    // verification only works reliably with the original raw payload.
    const raw =
      typeof req.rawBody === 'object'
        ? (req.rawBody?.toString('utf8') ?? JSON.stringify(body ?? {}))
        : JSON.stringify(body ?? {});
    return this.service.handleWebhook({
      storeId: body?.storeId ?? '',
      signature,
      body: raw,
    });
  }
}
