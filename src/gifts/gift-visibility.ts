// Single source of truth for "what does a viewer get to see on a gift".
// Composing every masking rule in one place means a new code path can't
// silently skip one of them.
//
//   1. maskAnonymous       — hides sender identity from the receiver when
//                            the buyer chose to send anonymously.
//   2. applySurpriseReveal — masks productName + storeName from the
//                            receiver when the sender flagged the gift
//                            as a surprise (until status === 'delivered').
//                            Sender + store ALWAYS see real values.
//   3. applyMessageReveal  — strips messageText + mediaUrl + mediaType
//                            from a receiver until status === 'delivered'.
//                            Sender always sees their own content.
//   4. applyAddressPrivacy — strips the recipient's delivery address
//                            from any sender-side response. Senders
//                            must NEVER see street / building / city
//                            details / phone — only that fulfilment is
//                            ready. Receiver sees their own address.
//
// `applyGiftVisibility(gift, viewerUserId)` is the function every gift-
// returning endpoint MUST call before responding. The combined helper
// adds two positive boolean flags the frontend reads to decide between
// real content and a placeholder card:
//   - `productVisible` — false ⇒ render the surprise/mystery card.
//   - `messageVisible` — false ⇒ render the locked-message card.

import { BadRequestException } from '@nestjs/common';

// Shape we strip for sender views. Mirrors ADDRESS_SELECT in
// gifts.service.ts. The exported version is `Partial<>` so callers
// don't need to track field-level optionality through the chain.
export type GiftAddress = {
  id: string;
  label: string | null;
  country: string;
  region: string | null;
  city: string;
  governorate: string | null;
  district: string;
  street: string | null;
  buildingNumber: string | null;
  unitNumber: string | null;
  postalCode: string | null;
  additionalNumber: string | null;
  shortAddress: string | null;
  deliveryPhone: string | null;
  details: string | null;
  isDefault: boolean;
};

export type GiftLike = {
  id: string;
  senderId: string;
  receiverId: string;
  productName: string;
  storeName: string;
  messageText: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  status: string;
  isAnonymous: boolean;
  isSurprise: boolean;
  addressId: string | null;
  // The actual delivery address row, if one is linked. Stripped for
  // the sender by applyAddressPrivacy below — so even though Prisma
  // includes it, the wire format hides it for non-recipient viewers.
  address?: GiftAddress | null;
  confirmedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  trackingNumber: string | null;
  carrier: string | null;
  createdAt: Date;
  sender: { id: string; qiftUsername: string; fullName: string | null };
  receiver: { id: string; qiftUsername: string; fullName: string | null };
};

// Hide the sender from the receiver's view when the gift is anonymous.
// Sender always sees their own info on the sent side.
export function maskAnonymous<T extends GiftLike>(
  gift: T,
  viewerUserId: string | null,
): T {
  if (!gift.isAnonymous) return gift;
  if (viewerUserId && viewerUserId === gift.senderId) return gift;
  return {
    ...gift,
    sender: { id: '', qiftUsername: '', fullName: null },
  };
}

// Surprise mode: when the sender flagged the gift as a surprise, mask
// the productName + storeName from the receiver until the gift is
// delivered. Sender + store/admin views always see real values — the
// mask is a receiver-side reveal gate, not an actual data scrub.
//
// Output adds `productVisible: boolean` (positive flag): `true` when
// the caller is allowed to see product + store, `false` when those
// fields have been scrubbed (and the frontend should render the
// mystery card).
export function applySurpriseReveal<T extends GiftLike>(
  gift: T,
  viewerUserId: string | null,
): T & { productVisible: boolean } {
  const isReceiverView =
    viewerUserId !== null && viewerUserId === gift.receiverId;
  const isDelivered = gift.status === 'delivered';
  const shouldHide = isReceiverView && gift.isSurprise && !isDelivered;
  if (!shouldHide) {
    return { ...gift, productVisible: true };
  }
  return {
    ...gift,
    productName: '',
    storeName: '',
    productVisible: false,
  };
}

// Receiver sees the actual content (text + media) only after the gift
// has been delivered. Pre-delivery we strip messageText, mediaUrl, AND
// mediaType so the API never leaks even a hint about whether the buyer
// attached an image or video — the locked placeholder is identical for
// every pending gift.
//
// The sender is never affected — they wrote the thing, they should
// always be able to verify what they sent.
//
// Output adds `messageVisible: boolean` (positive flag): `true` when the
// caller is allowed to see message + media, `false` when those fields
// have been stripped.
export function applyMessageReveal<T extends GiftLike>(
  gift: T,
  viewerUserId: string | null,
): T & { messageVisible: boolean } {
  const isReceiverView =
    viewerUserId !== null && viewerUserId === gift.receiverId;
  const isDelivered = gift.status === 'delivered';
  const shouldHide = isReceiverView && !isDelivered;
  if (!shouldHide) {
    return { ...gift, messageVisible: true };
  }
  return {
    ...gift,
    messageText: null,
    mediaUrl: null,
    mediaType: null,
    messageVisible: false,
  };
}

// Strip the recipient's delivery address from any sender-side
// response. Sender must NEVER see street / building / city details /
// phone — only that fulfilment is ready. The receiver sees their own
// address (so they can verify which one was selected); admin / store
// fulfilment paths use a different code path and aren't filtered
// here.
//
// We zero out BOTH `address` (the inline relation Prisma returns) and
// `addressId` (the FK column). The id alone isn't useful to a sender
// — `/addresses/:id` enforces ownership — but stripping it keeps the
// wire format clean of "the gift has SOME address pinned" metadata.
//
// Output adds `addressConfirmed: boolean` (positive flag). The sender
// UI reads this to decide between "Recipient confirmed the delivery
// address — preparing soon" copy and the earlier "Waiting for
// recipient" copy without ever needing the address itself.
export function applyAddressPrivacy<T extends GiftLike>(
  gift: T,
  viewerUserId: string | null,
): T & { addressConfirmed: boolean } {
  const isReceiverView =
    viewerUserId !== null && viewerUserId === gift.receiverId;
  // Status discriminator. Once an address has been pinned (either by
  // the receiver via confirm-address or by the 24h auto-default
  // sweep) the gift moves to one of these statuses.
  const ADDRESS_LOCKED_STATUSES = new Set([
    'address_confirmed',
    'default_address_used',
    'preparing',
    'shipped',
    'delivered',
  ]);
  const addressConfirmed =
    !!gift.addressId && ADDRESS_LOCKED_STATUSES.has(gift.status);
  if (isReceiverView) {
    // Receiver gets to see their own address as-is.
    return { ...gift, addressConfirmed };
  }
  // Sender view (or anyone non-receiver): scrub every address-shaped
  // field. Even the FK is stripped so the response shape carries no
  // implicit "an address exists" hint beyond the positive boolean.
  return {
    ...gift,
    address: null,
    addressId: null,
    addressConfirmed,
  };
}

// Apply every mask in the canonical order. Every gift-returning service
// method MUST call this before returning to the controller.
//
// Order matters only for readability — none of the helpers depend on
// each other's output. We keep anonymity → surprise → message →
// address because that's roughly "identity → product → contents →
// fulfilment", which mirrors how a real receiver mentally peels the
// gift while a sender experiences progress milestones.
export function applyGiftVisibility<T extends GiftLike>(
  gift: T,
  viewerUserId: string | null,
): T & {
  productVisible: boolean;
  messageVisible: boolean;
  addressConfirmed: boolean;
} {
  const a = maskAnonymous(gift, viewerUserId);
  const b = applySurpriseReveal(a, viewerUserId);
  const c = applyMessageReveal(b, viewerUserId);
  return applyAddressPrivacy(c, viewerUserId);
}

// --- Media validation ---

// Allowed media discriminators. Future upload endpoint should call this
// helper to reject malformed payloads in the same place create-gift does.
const ALLOWED_MEDIA_TYPES = new Set(['image', 'video']);

export type ValidatedMedia = {
  mediaUrl: string | null;
  mediaType: 'image' | 'video' | null;
};

// Normalise + validate a (mediaUrl, mediaType) pair. Returns nulls when
// no media was supplied. Throws BadRequestException when the pair is
// inconsistent (URL without type, or type outside the allow-list while
// a URL is present). Safe to call with `undefined` inputs.
export function validateGiftMedia(
  mediaUrl: string | null | undefined,
  mediaType: string | null | undefined,
): ValidatedMedia {
  const url = typeof mediaUrl === 'string' ? mediaUrl.trim() : '';
  const type =
    typeof mediaType === 'string' && ALLOWED_MEDIA_TYPES.has(mediaType)
      ? (mediaType as 'image' | 'video')
      : null;
  if (!url) {
    return { mediaUrl: null, mediaType: null };
  }
  if (!type) {
    throw new BadRequestException(
      'mediaType must be "image" or "video" when mediaUrl is set',
    );
  }
  return { mediaUrl: url, mediaType: type };
}
