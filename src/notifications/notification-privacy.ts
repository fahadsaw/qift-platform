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

// ─────────────────────────────────────────────────────────────────────
// Week 2 — Anonymous-sender masking.
//
// The platform's anonymous-gift contract: a recipient receiving an
// anonymous gift must NEVER learn the sender's identity through
// ANY notification surface (push title, push body, email subject,
// email body, in-app row title, in-app row body, digest aggregate).
//
// The audit at the time of this commit confirmed every receiver-
// facing gift notification producer (gifts.service / gifts-auto-
// default.service / store.service / addresses.service) uses
// generic titles + product/store strings in bodies — none currently
// reference `sender.qiftUsername` or `sender.fullName`. The helpers
// below install the CONTRACT so any future producer wanting to
// render "X sent you a gift" must thread through
// senderDisplayForReceiverGiftNotification, which returns `null`
// for anonymous gifts. A future template doing
// `title: \`${senderDisplay} sent you a gift\`` would render an
// awkward `null sent you a gift` for anonymous — a clear signal
// during code review that the producer needs a sender-less variant
// rather than a silent identity leak.
//
// Pure module: no Prisma, no Nest. Tested in isolation.
// ─────────────────────────────────────────────────────────────────────

// The minimal Gift projection this helper needs. Producers project
// this from their richer Gift type; the structural-subset signature
// lets callers pass any wider shape (Prisma rows, Gift includes,
// etc.) without an explicit cast.
export type AnonAwareGift = {
  // Required: the anonymous flag on the Gift row.
  isAnonymous: boolean;
  // Optional sender projection. Producers that don't have a
  // populated `sender` (e.g. before a Prisma include resolves) get
  // a defensive null — same observable result as anonymous, no
  // leak path.
  sender?: {
    qiftUsername?: string | null;
    fullName?: string | null;
  } | null;
};

// Should the producer hide sender identity from a receiver-facing
// notification? Single-purpose predicate so other code (titles,
// digest aggregation, future surfaces) can consult the same rule.
// Sender-side notifications NEVER mask — those notifications go
// to the sender themselves and "concealing" the sender from
// themselves would be theatrical, not protective.
export function shouldMaskGiftSender(gift: AnonAwareGift): boolean {
  return gift.isAnonymous === true;
}

// Returns the display string the producer should render for the
// sender in a receiver-facing notification — OR `null` when the
// gift is anonymous (or when the sender projection is missing,
// which is treated as the same "no identity" state for safety).
//
// Producers that want to compose "{name} sent you a gift" should:
//   const senderDisplay = senderDisplayForReceiverGiftNotification(gift);
//   const title = senderDisplay
//     ? `${senderDisplay} sent you a gift`
//     : 'You received a gift';
//
// The structured return — display string OR null — forces the
// producer to write the sender-less branch as a deliberate code
// path. A producer that interpolates the return value blindly will
// render `null sent you a gift` in dev/staging — an obvious
// regression signal that the sender-less branch is missing.
export function senderDisplayForReceiverGiftNotification(
  gift: AnonAwareGift,
): string | null {
  if (shouldMaskGiftSender(gift)) return null;
  const fullName = gift.sender?.fullName?.trim();
  if (fullName) return fullName;
  const handle = gift.sender?.qiftUsername?.trim();
  if (handle) return `@${handle}`;
  // Sender projection missing — defense in depth: behave as if
  // anonymous. Producers should never reach this branch in well-
  // formed flows.
  return null;
}

// Track A.5: append the canonical QF fulfillment reference to a
// notification body so anyone reading the notification to support has
// something quotable. Surprise-safe by construction — when the masked
// body is null, the reference alone remains, and a random reference
// reveals nothing about the gift.
export function withFulfillmentRef(body: string | null, ref: string): string {
  return body ? `${body} · ${ref}` : ref;
}
