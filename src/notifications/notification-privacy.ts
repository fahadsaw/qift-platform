// Notification-producer privacy helpers.
//
// These helpers exist for ONE reason: to keep the "surprise gift"
// invariant from leaking via downstream notification bodies. Surprise
// mode masks `productName` + `storeName` on the receiver's view of
// the gift until it reaches `delivered`. The original /gifts POST
// already respects this on the FIRST notification (GiftReceived).
// But every subsequent status update — preparing, shipped,
// cancelled, auto-fallback-blocked, default-address-used — used
// `body: gift.productName` regardless of `isSurprise`, leaking the
// product identity through the push fanout even though the in-app
// gift card would still render the surprise mask.
//
// This module centralises the rule so producers don't accidentally
// regress it. Each producer that writes a receiver-facing
// notification about a not-yet-delivered gift MUST pass the body
// through `bodyForReceiverGiftUpdate(...)` instead of inlining
// `gift.productName`.
//
// Rule (single source of truth):
//   - If the gift is in surprise mode AND has NOT been delivered:
//     the body is masked (returns null). The push body / title is
//     calm + generic ("Your gift is being prepared.") — no product
//     reveal, no merchant hint.
//   - Otherwise: the body returns `productName` (or whatever the
//     producer wanted to render). The reveal point is delivery —
//     once the gift status reaches `delivered`, the receiver has
//     seen it physically; the surprise has resolved.
//
// Sender-side notifications are NEVER masked: the sender chose the
// product themselves, so concealing it from their own
// notification would be theatrical, not protective.
//
// Pure module: no Prisma, no Nest. Tested in isolation.

export type SurpriseAwareGift = {
  // Required: the surprise flag on the Gift row.
  isSurprise: boolean;
  // Required: the current Gift.status. The mask lifts at
  // 'delivered' (the only canonical reveal point). Anything else
  // — pending_address / address_confirmed / preparing / shipped /
  // cancelled — keeps the mask on.
  status: string;
};

// Should the producer mask the body? Single-purpose predicate so
// other code (titles, deep-link previews, future surfaces) can
// consult the same rule.
export function shouldMaskGiftBody(gift: SurpriseAwareGift): boolean {
  if (!gift.isSurprise) return false;
  // The reveal point. After delivery, the surprise has resolved
  // by definition — the receiver has the gift in their hands.
  if (gift.status === 'delivered') return false;
  return true;
}

// Compose the receiver-facing notification body for a gift status
// update. The producer passes the candidate body (typically
// `gift.productName` or `productName — storeName`); we return
// either that string OR null when the surprise mask applies.
//
// Returning `null` is the architecture's signal to the push
// pipeline that the body should be omitted from the notification
// payload entirely — the user sees only the title, which producers
// keep generic ("Your gift is being prepared.").
export function bodyForReceiverGiftUpdate(
  gift: SurpriseAwareGift,
  candidateBody: string | null,
): string | null {
  if (shouldMaskGiftBody(gift)) return null;
  return candidateBody;
}
