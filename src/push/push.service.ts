import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

// Allow-list of internal paths a push payload's `url` may point at. The
// service worker also re-checks this client-side, but we additionally
// validate at send-time so a malicious caller can't get the OS to deep-
// link to a third party. New routes need to be added here explicitly.
//
// Members:
//   /notifications    — bell / digest landing
//   /gifts            — gift detail timeline (all gift-flow pushes)
//   /store-dashboard  — merchant-side order notifications
//   /occasions        — Phase 7.2 reminder worker deep-link
//   /profile          — GiftAttemptedNoAddress recipient prompt
//   /send             — GiftAddressReadyForRetry sender retry prompt
//
// Adding to this list must be deliberate. A prefix not on the list
// gets silently rewritten to /notifications by sanitisePayload(),
// which is safe (no XSS / open-redirect risk) but produces a
// confusing UX — the push lands on the wrong page.
const SAFE_URL_PREFIXES = [
  '/notifications',
  '/gifts',
  '/store-dashboard',
  '/occasions',
  '/profile',
  '/send',
];

export type PushPayload = {
  title: string;
  body?: string | null;
  url?: string | null;
  // Carried through to the SW so it can route by event kind without
  // parsing the URL. Mirrors NotificationType strings (e.g. "gift.shipped").
  type?: string;
};

// Subscription rows passed to web-push. Pulled out as a type alias so the
// trigger code in NotificationsService can stay strongly typed.
type StoredSub = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type SubscribeInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
};

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  // Set to true once setVapidDetails has run successfully. When false,
  // sendToUser short-circuits — no crashes, just a one-line warning the
  // first time a send is attempted.
  private vapidConfigured = false;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:ops@qift.net';

    if (!publicKey || !privateKey) {
      this.logger.warn(
        'VAPID keys are not set — push notifications are disabled. ' +
          'Run `npx web-push generate-vapid-keys` and export ' +
          'VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY to enable.',
      );
      return;
    }
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.vapidConfigured = true;
      this.logger.log('VAPID configured — push notifications are enabled.');
    } catch (err) {
      // Bad key format etc. — keep the app running; sends will no-op.
      this.logger.warn(
        `Failed to configure VAPID: ${(err as Error).message}. ` +
          'Push notifications are disabled.',
      );
    }
  }

  // Whether a Subscribe button on the frontend should even be enabled.
  isConfigured(): boolean {
    return this.vapidConfigured;
  }

  async subscribe(viewerUserId: string, body: SubscribeInput) {
    const endpoint = body?.endpoint?.trim();
    const p256dh = body?.keys?.p256dh?.trim();
    const auth = body?.keys?.auth?.trim();
    if (!endpoint || !p256dh || !auth) {
      throw new Error('endpoint and keys are required');
    }
    const userAgent = body.userAgent?.slice(0, 512) || null;

    // Upsert by endpoint. The same browser hitting subscribe again
    // shouldn't accumulate dead rows — it should refresh in place. If
    // the endpoint moved between users (rare; e.g. shared device), the
    // ownership flips so we don't keep notifying the wrong account.
    return this.prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: viewerUserId, endpoint, p256dh, auth, userAgent },
      update: { userId: viewerUserId, p256dh, auth, userAgent },
      select: { id: true, endpoint: true, createdAt: true },
    });
  }

  async unsubscribe(viewerUserId: string, endpoint: string) {
    const trimmed = endpoint?.trim();
    if (!trimmed) return { ok: false, removed: 0 };
    // Scope by userId so a malicious client can't unsubscribe someone
    // else's device just by knowing the endpoint URL.
    const result = await this.prisma.pushSubscription.deleteMany({
      where: { endpoint: trimmed, userId: viewerUserId },
    });
    return { ok: true, removed: result.count };
  }

  async status(viewerUserId: string) {
    const count = await this.prisma.pushSubscription.count({
      where: { userId: viewerUserId },
    });
    return {
      enabled: count > 0,
      count,
      // Surface configuration state so the settings page can render the
      // right friendly message ("setup pending" vs "enable").
      vapidConfigured: this.vapidConfigured,
    };
  }

  // Fan out a push to every device the user has registered. Each send is
  // independent — one failure doesn't poison the others. 404/410 from
  // the push service means the subscription is permanently dead, so we
  // delete the row to keep the table clean.
  //
  // FIRE-AND-FORGET friendly: NotificationsService.trigger calls this
  // without awaiting, and the method swallows internal errors so a push
  // outage can't ripple back into the original gift-create / payment /
  // status-flip flow.
  async sendToUser(
    userId: string,
    payload: PushPayload,
  ): Promise<{ sent: number; pruned: number }> {
    if (!this.vapidConfigured) return { sent: 0, pruned: 0 };
    const safe = sanitisePayload(payload);
    if (!safe) return { sent: 0, pruned: 0 };

    let subs: StoredSub[];
    try {
      subs = await this.prisma.pushSubscription.findMany({
        where: { userId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
    } catch (err) {
      this.logger.warn(
        `Push send: failed to load subscriptions for user ${userId}: ${(err as Error).message}`,
      );
      return { sent: 0, pruned: 0 };
    }
    if (subs.length === 0) return { sent: 0, pruned: 0 };

    const json = JSON.stringify(safe);
    const results = await Promise.all(subs.map((s) => this.sendOne(s, json)));

    const sent = results.filter((r) => r === 'ok').length;
    const dead = results
      .map((r, i) => (r === 'dead' ? subs[i].id : null))
      .filter((id): id is string => id !== null);

    if (dead.length > 0) {
      await this.prisma.pushSubscription
        .deleteMany({ where: { id: { in: dead } } })
        .catch(() => undefined);
    }
    return { sent, pruned: dead.length };
  }

  // Returns 'ok' on a successful send, 'dead' when the subscription is
  // gone (404/410), 'error' for anything else. We never throw out of
  // here — the parent promise.all needs every result.
  private async sendOne(
    sub: StoredSub,
    json: string,
  ): Promise<'ok' | 'dead' | 'error'> {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        json,
      );
      return 'ok';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'dead';
      this.logger.warn(
        `Push send failed (status=${status ?? 'n/a'}, endpoint=${sub.endpoint.slice(
          0,
          60,
        )}…): ${(err as Error).message}`,
      );
      return 'error';
    }
  }
}

// Drops payloads with empty titles, clamps lengths so we never pop a
// 4kb push body, and rewrites the URL to "/" if it isn't on the safe
// allow-list. Defence in depth — the SW does the same check client-side
// but we never want to even put a sketchy URL on the wire.
function sanitisePayload(p: PushPayload): PushPayload | null {
  const title = p.title?.trim();
  if (!title) return null;
  const body = p.body?.toString().trim().slice(0, 280) || null;
  const rawUrl = p.url?.toString().trim() || null;
  const url =
    rawUrl && SAFE_URL_PREFIXES.some((prefix) => rawUrl.startsWith(prefix))
      ? rawUrl
      : '/notifications';
  return {
    title: title.slice(0, 120),
    body,
    url,
    type: p.type?.toString().slice(0, 60),
  };
}
