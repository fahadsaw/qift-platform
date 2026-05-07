import { BadRequestException } from '@nestjs/common';

// Final tracking pipeline. Order matches the timeline rendered in the UI.
//
// Forward (happy) path:
//   pending_address → address_confirmed   (receiver picked an address)
//                  ↘ default_address_used (24h sweep used their default)
//   address_confirmed | default_address_used → preparing (store accepts)
//   preparing → shipped → delivered
//
// Terminal:
//   delivered  — happy-path end.
//   cancelled  — sender cancelled (only allowed before `preparing` —
//                once the store has the order, cancellation needs the
//                refund flow which is not modeled as a state edge yet).
//
// `cancelled` is only reachable from the pre-store-accept statuses
// (pending_address / address_confirmed / default_address_used). Both
// terminal states have an empty allow-list so a future caller can't
// silently transition a delivered or cancelled gift back into the
// pipeline.
export const GIFT_STATUSES = [
  'pending_address',
  'address_confirmed',
  'default_address_used',
  'preparing',
  'shipped',
  'delivered',
  'cancelled',
] as const;

export type GiftStatus = (typeof GIFT_STATUSES)[number];

// Allowed `from -> to` edges. Anything not listed here throws via
// `assertTransition`. `delivered` and `cancelled` are terminal.
export const ALLOWED_TRANSITIONS: Record<GiftStatus, GiftStatus[]> = {
  pending_address: ['address_confirmed', 'default_address_used', 'cancelled'],
  address_confirmed: ['preparing', 'cancelled'],
  default_address_used: ['preparing', 'cancelled'],
  preparing: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function isGiftStatus(value: string): value is GiftStatus {
  return (GIFT_STATUSES as readonly string[]).includes(value);
}

// Throws BadRequestException if the transition isn't allowed by the graph.
// Returns silently when valid. Idempotent same-state moves are NOT allowed
// here — callers that want idempotency should short-circuit themselves so
// they can return the row unchanged.
export function assertTransition(from: string, to: GiftStatus): void {
  if (!isGiftStatus(from)) {
    throw new BadRequestException(`حالة غير معروفة: ${from}`);
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new BadRequestException(
      `لا يمكن نقل الحالة من "${from}" إلى "${to}"`,
    );
  }
}

// Display order for the timeline. Used by the UI; we expose it from the
// backend module so we have a single source of truth.
export const TIMELINE_ORDER: ReadonlyArray<{
  key: GiftStatus | 'created';
  // The "address" timeline step collapses both address_confirmed and
  // default_address_used into one slot — they're alternate paths through
  // the same milestone. The discriminator stays in the row's status.
  group?: 'address';
}> = [
  { key: 'created' },
  { key: 'address_confirmed', group: 'address' },
  { key: 'preparing' },
  { key: 'shipped' },
  { key: 'delivered' },
];
