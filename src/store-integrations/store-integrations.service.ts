import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StoresService } from '../stores/stores.service';

// Allow-list of integration adapters we plan to support. Anything outside
// this set is rejected by `connect`. Add new platforms by appending to
// this list — the adapter selection inside `runSync` switches on it too.
export const INTEGRATION_TYPES = [
  'none',
  'api',
  'shopify',
  'woocommerce',
  'custom',
] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export type ConnectInput = {
  storeId?: string;
  integrationType?: IntegrationType;
};

export type SyncInput = {
  storeId?: string;
};

@Injectable()
export class StoreIntegrationsService {
  private readonly logger = new Logger(StoreIntegrationsService.name);

  constructor(
    private prisma: PrismaService,
    private stores: StoresService,
  ) {}

  // Connect a store to an upstream platform. We:
  //   1. Verify the JWT viewer owns the store.
  //   2. Stamp `integrationType` + `integrationStatus = connected`.
  //   3. Mint a new `webhookSecret` (HMAC key the upstream platform will
  //      sign webhook payloads with). Returned ONCE on connect — callers
  //      must persist it themselves; we don't expose it via list/detail.
  // The actual platform handshake (OAuth, API key exchange, etc.) is
  // intentionally stubbed so the rest of the system can be wired up
  // first; replace this body when the real integration ships.
  async connect(viewerUserId: string, body: ConnectInput) {
    const storeId = body.storeId?.trim();
    const integrationType = body.integrationType;
    if (!storeId) {
      throw new BadRequestException('storeId is required');
    }
    if (!integrationType || !INTEGRATION_TYPES.includes(integrationType)) {
      throw new BadRequestException('integrationType is invalid');
    }
    if (integrationType === 'none') {
      // "none" means disconnect. Clear the secret too so a re-connect
      // mints a fresh one.
      await this.stores.assertOwner(viewerUserId, storeId);
      const updated = await this.prisma.store.update({
        where: { id: storeId },
        data: {
          integrationType: 'none',
          integrationStatus: 'disconnected',
          webhookSecret: null,
        },
      });
      return {
        id: updated.id,
        integrationType: updated.integrationType,
        integrationStatus: updated.integrationStatus,
        // Never echo the (null) secret back.
      };
    }
    await this.stores.assertOwner(viewerUserId, storeId);
    const secret = randomBytes(32).toString('hex');
    const updated = await this.prisma.store.update({
      where: { id: storeId },
      data: {
        integrationType,
        integrationStatus: 'connected',
        webhookSecret: secret,
      },
    });
    return {
      id: updated.id,
      integrationType: updated.integrationType,
      integrationStatus: updated.integrationStatus,
      // Returned ONCE. Store-side caller must persist this — we deliberately
      // never expose it via /stores/:id afterwards.
      webhookSecret: secret,
    };
  }

  // Trigger a sync. For v1 this is a stub that just stamps `lastSyncedAt`
  // on every existing API-sourced product so the dashboard shows
  // movement; the real implementation will pull from the upstream API
  // and feed `applySyncBatch` (below).
  async syncProducts(viewerUserId: string, body: SyncInput) {
    const storeId = body.storeId?.trim();
    if (!storeId) throw new BadRequestException('storeId is required');
    const store = await this.stores.assertOwner(viewerUserId, storeId);
    const fullStore = await this.prisma.store.findUnique({
      where: { id: store.id },
      select: { integrationType: true, integrationStatus: true },
    });
    if (!fullStore || fullStore.integrationType === 'none') {
      throw new BadRequestException('المتجر غير مرتبط بأي تكامل');
    }
    const result = await this.prisma.product.updateMany({
      where: { storeId, sourceType: 'api' },
      data: { lastSyncedAt: new Date() },
    });
    this.logger.log(
      `Stub sync ran for store=${storeId}; touched ${result.count} products`,
    );
    return { ok: true, syncedCount: result.count };
  }

  // Webhook receiver. We verify the HMAC signature against the store's
  // saved `webhookSecret` (constant-time compare) before doing anything
  // with the payload. The payload itself is a no-op for v1 — replace the
  // try block with whatever the upstream platform sends.
  async handleWebhook(opts: {
    storeId: string;
    signature: string | undefined;
    body: string;
  }) {
    const { storeId, signature, body } = opts;
    if (!storeId || !signature) {
      throw new UnauthorizedException('بيانات اعتماد التوقيع ناقصة');
    }
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, webhookSecret: true, integrationStatus: true },
    });
    if (!store?.webhookSecret) {
      throw new UnauthorizedException('المتجر لا يقبل ويب هوك');
    }

    const expected = createHmac('sha256', store.webhookSecret)
      .update(body, 'utf8')
      .digest('hex');
    let ok = false;
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      ok = a.length === b.length && timingSafeEqual(a, b);
    } catch {
      ok = false;
    }
    if (!ok) {
      // On verification failure we also flip the store into `error` so
      // the dashboard surfaces it. Not idempotent — multiple bad calls
      // re-stamp the same state, which is fine.
      await this.prisma.store.update({
        where: { id: storeId },
        data: { integrationStatus: 'error' },
      });
      throw new UnauthorizedException('توقيع غير صالح');
    }

    // TODO: parse `body` and dispatch to applySyncBatch / stock updates.
    // Returning early so the upstream platform sees a 2xx and stops
    // retrying.
    return { ok: true };
  }
}
