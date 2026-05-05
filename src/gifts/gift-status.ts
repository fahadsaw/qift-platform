import { BadRequestException } from '@nestjs/common';

// Final tracking pipeline. Order matches the timeline rendered in the UI.
export const GIFT_STATUSES = [
  'pending_address',
  'address_confirmed',
  'default_address_used',
  'preparing',
  'shipped',
  'delivered',
] as const;

export type GiftStatus = (typeof GIFT_STATUSES)[number];

// Allowed `from -> to` edges. Anything not listed here throws via
// `assertTransition`. The empty array on `delivered` makes it terminal.
export const ALLOWED_TRANSITIONS: Record<GiftStatus, GiftStatus[]> = {
  pending_address: ['address_confirmed', 'default_address_used'],
  address_confirmed: ['preparing'],
  default_address_used: ['preparing'],
  preparing: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
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
