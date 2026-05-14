// Phase 7.1 — notification category registry.
//
// Every notification fired through the orchestrator carries a
// category. The category drives:
//   - which channels can deliver it (in-app / push / email / SMS)
//   - whether it bypasses quiet hours
//   - whether it bypasses budget limits
//   - whether the user can opt out
//   - default budget caps
//
// The registry is INTENTIONALLY static — categories are
// architectural decisions, not data. Adding one requires a code
// review + a written justification in this file.
//
// Pure module: no Prisma, no Nest. Used by the orchestrator
// service + can be unit-tested standalone.

import { NotificationType } from './notifications.service';

// ── Category enum ───────────────────────────────────────────────

// String-union pattern for stability — same convention used by
// NotificationType. New categories go ONLY at the bottom of the
// list; reordering breaks any serialised preference dict.
export const NotificationCategory = {
  // Security-critical: account recovery / verification / fraud.
  // CANNOT be silenced. Bypasses everything.
  Security: 'security',
  // One-time passcodes (registration, password reset). Same
  // semantics as Security but a separate audit lane so rate
  // limits are tracked independently.
  Otp: 'otp',
  // Legal / account-critical messages — terms updates, account
  // closure notices, regulatory disclosures. Mandatory.
  Legal: 'legal',
  // Gift lifecycle: received / address-confirm / preparing /
  // shipped / delivered / cancelled. High priority (the gift
  // flow is the platform's load-bearing motion) but the user
  // CAN opt out of the lower-impact subset (preparing /
  // shipped) via finer category preferences later.
  GiftUpdate: 'gift_update',
  // Receiver must confirm an address before the gift can ship.
  // High priority — escalates to SMS via the existing 24h
  // fallback if needed.
  AddressConfirm: 'address_confirm',
  // Sender-side merchant-action notifications: merchant accepted
  // / declined / shipped. Mostly real-time push for engaged
  // senders.
  MerchantOrder: 'merchant_order',
  // Occasion reminders. The whole point of the Phase 6 reminder
  // data layer. Real delivery is GATED OFF in Phase 7.1; the
  // category exists so the orchestrator can route correctly
  // once the worker is enabled.
  OccasionReminder: 'occasion_reminder',
  // Social / gift-appreciation: someone tapped 👍 on a published
  // GiftPost. Aggregate-only bodies; per-post-per-owner 24h
  // dedupe already in NotificationsService.
  Social: 'social',
  // System / housekeeping (new device login, push subscription
  // expiry warnings, etc.). Low priority.
  System: 'system',
} as const;

export type NotificationCategory =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];

// ── Category metadata ───────────────────────────────────────────

export type Priority = 'critical' | 'high' | 'normal' | 'low';
export type Channel = 'in_app' | 'push' | 'email' | 'sms';

export type CategoryDescriptor = {
  priority: Priority;
  // Channels this category MAY use. The orchestrator further
  // filters by per-user channel preferences + provider
  // availability. In-app is ALWAYS included for every category
  // (the bell is the always-on inbox).
  eligibleChannels: ReadonlyArray<Channel>;
  // When true, the orchestrator delivers regardless of:
  //   - user opt-out for this category
  //   - quiet hours
  //   - daily / weekly budget caps
  // Mandatory does NOT bypass abuse rate limits (OTP still has
  // its own per-channel throttle in OtpService).
  mandatory: boolean;
  // Per-day cap PER USER for this category. Exceeded → orchestrator
  // queues the alert channels for digest (in-app inbox still
  // receives the row). Null means "no daily cap" (typically only
  // for mandatory categories).
  dailyCap: number | null;
  // Per-week cap PER USER. Same suppression behaviour.
  weeklyCap: number | null;
  // Translation key prefix the orchestrator uses to pick the
  // generic notification body. Privacy invariant: bodies must
  // be generic — never include recipient address, hidden
  // sender identity, private occasion content, etc.
  bodyKeyPrefix: string;
};

// The architectural truth table. Each line is a deliberate
// product / privacy decision; comments explain the why.
//
// Mandatory categories (security / OTP / legal): every channel
// eligible, no opt-out, no quiet-hours bypass. Other categories
// default to in-app + push, with email reserved for the lower
// time-sensitivity rows.
const REGISTRY: Record<NotificationCategory, CategoryDescriptor> = {
  // ─── Mandatory ───
  [NotificationCategory.Security]: {
    priority: 'critical',
    eligibleChannels: ['in_app', 'push', 'email', 'sms'],
    mandatory: true,
    dailyCap: null,
    weeklyCap: null,
    bodyKeyPrefix: 'notif.security',
  },
  [NotificationCategory.Otp]: {
    priority: 'critical',
    // OTP intentionally limits its channel set to delivery
    // mechanisms that prove control (SMS to the registered
    // phone; email to the verified address). In-app/push are
    // useless for OTP since the user can't read them from a
    // logged-out device.
    eligibleChannels: ['sms', 'email'],
    mandatory: true,
    dailyCap: null,
    weeklyCap: null,
    bodyKeyPrefix: 'notif.otp',
  },
  [NotificationCategory.Legal]: {
    priority: 'critical',
    eligibleChannels: ['in_app', 'push', 'email'],
    mandatory: true,
    dailyCap: null,
    weeklyCap: null,
    bodyKeyPrefix: 'notif.legal',
  },

  // ─── High-priority operational ───
  [NotificationCategory.AddressConfirm]: {
    priority: 'high',
    eligibleChannels: ['in_app', 'push', 'email', 'sms'],
    // NOT mandatory in the strict sense — a user can mute address
    // confirmation prompts via opt-out, BUT the existing 24h
    // fallback flow already escalates regardless. The opt-out
    // here suppresses the in-app/push noise, not the underlying
    // gift-flow safety net.
    mandatory: false,
    // Generous cap — receiving a few address-confirm pings in a
    // day is plausible (multiple senders), but 10+ is noise.
    dailyCap: 10,
    weeklyCap: 30,
    bodyKeyPrefix: 'notif.address_confirm',
  },
  [NotificationCategory.GiftUpdate]: {
    priority: 'high',
    eligibleChannels: ['in_app', 'push', 'email'],
    mandatory: false,
    dailyCap: 20,
    weeklyCap: 60,
    bodyKeyPrefix: 'notif.gift_update',
  },
  [NotificationCategory.MerchantOrder]: {
    priority: 'high',
    eligibleChannels: ['in_app', 'push', 'email'],
    mandatory: false,
    dailyCap: 30,
    weeklyCap: 100,
    bodyKeyPrefix: 'notif.merchant_order',
  },

  // ─── Calm scheduled ───
  [NotificationCategory.OccasionReminder]: {
    priority: 'normal',
    // Notification real-time fanout NOT WIRED in Phase 7.1 — the
    // delivery worker stays gated behind QIFT_OCCASION_REMINDER_
    // FIRING_ENABLED. This descriptor describes the eventual
    // behaviour. In-app still writes the row; push is what
    // the gate suppresses.
    eligibleChannels: ['in_app', 'push', 'email'],
    mandatory: false,
    // Calm by design — at most a few reminders a day. The
    // per-occasion T-7 / T-3 / T-0 cadence on the reminder row
    // plus this cap keeps the firing budget well below "noisy".
    dailyCap: 5,
    weeklyCap: 15,
    bodyKeyPrefix: 'notif.occasion_reminder',
  },

  // ─── Social ───
  [NotificationCategory.Social]: {
    priority: 'low',
    eligibleChannels: ['in_app', 'push'],
    mandatory: false,
    // Tight cap — social pings are the easiest to balloon into
    // engagement noise. The per-post-per-owner 24h dedupe in
    // NotificationsService is the first line of defence; this
    // cap is the second.
    dailyCap: 8,
    weeklyCap: 25,
    bodyKeyPrefix: 'notif.social',
  },

  // ─── System ───
  [NotificationCategory.System]: {
    priority: 'low',
    eligibleChannels: ['in_app', 'push'],
    mandatory: false,
    dailyCap: 3,
    weeklyCap: 10,
    bodyKeyPrefix: 'notif.system',
  },
};

// ── Lookup helpers ──────────────────────────────────────────────

export function descriptorFor(
  category: NotificationCategory,
): CategoryDescriptor {
  return REGISTRY[category];
}

export function isMandatory(category: NotificationCategory): boolean {
  return REGISTRY[category].mandatory;
}

// Map the legacy NotificationType (gift.received etc.) strings
// into the category they belong to. Used by NotificationsService.
// trigger() so existing call sites don't need to be touched —
// they pass `type`, orchestrator looks up category here.
//
// Unknown types route to System (lowest impact). Adding a new
// NotificationType means adding a line here at the same time;
// the test suite asserts every NotificationType has a mapping.
export function categoryForType(type: string): NotificationCategory {
  switch (type) {
    case NotificationType.GiftReceived:
    case NotificationType.GiftPreparing:
    case NotificationType.GiftShipped:
    case NotificationType.GiftDelivered:
    case NotificationType.GiftCancelled:
    case NotificationType.GiftAttemptedNoAddress:
    case NotificationType.GiftAddressReadyForRetry:
    case NotificationType.GiftDefaultAddressUsed:
      return NotificationCategory.GiftUpdate;

    case NotificationType.GiftConfirmAddress:
    case NotificationType.GiftAddressConfirmed:
    case NotificationType.GiftReadyForDelivery:
    case NotificationType.GiftAutoFallbackBlocked:
      return NotificationCategory.AddressConfirm;

    case NotificationType.GiftPostAppreciated:
      return NotificationCategory.Social;

    default:
      // Unrecognised legacy type. System is the safe default —
      // low priority, opt-outable, in-app + push only. If you're
      // adding a new NotificationType and this branch is firing,
      // map it here explicitly.
      return NotificationCategory.System;
  }
}

// Read-only view of the registry — exported for tests and the
// preferences-API response shape (so the frontend can render the
// per-category opt-out list without duplicating the truth here).
export function listCategories(): Array<{
  id: NotificationCategory;
  descriptor: CategoryDescriptor;
}> {
  return (Object.keys(REGISTRY) as NotificationCategory[]).map((id) => ({
    id,
    descriptor: REGISTRY[id],
  }));
}
