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
//
// `applyGiftVisibility(gift, viewerUserId)` is the function every gift-
// returning endpoint MUST call before responding. The combined helper
// adds two positive boolean flags the frontend reads to decide between
// real content and a placeholder card:
//   - `productVisible` — false ⇒ render the surprise/mystery card.
//   - `messageVisible` — false ⇒ render the locked-message card.

import { BadRequestException } from '@nestjs/common';

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

// Apply every mask in the canonical order. Every gift-returning service
// method MUST call this before returning to the controller.
//
// Order matters only for readability — none of the helpers depend on
// each other's output. We keep anonymity → surprise → message because
// that's roughly "identity → product → contents", which mirrors how a
// real receiver mentally peels the gift.
export function applyGiftVisibility<T extends GiftLike>(
  gift: T,
  viewerUserId: string | null,
): T & { productVisible: boolean; messageVisible: boolean } {
  const a = maskAnonymous(gift, viewerUserId);
  const b = applySurpriseReveal(a, viewerUserId);
  return applyMessageReveal(b, viewerUserId);
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
