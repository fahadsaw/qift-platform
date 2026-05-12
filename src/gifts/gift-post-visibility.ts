// Gift-post visibility + identity-masking helpers.
//
// FOUNDATION ONLY — no endpoints consume these yet. The helpers
// live here so when the feed / per-gift publish surface ships,
// every reader / writer routes through one place and the
// privacy-first rules can't drift across surfaces.
//
// PHILOSOPHY (do not violate when extending; see memory entries
// `project_privacy_first_posts.md`,
// `project_gift_centric_social.md`,
// `feedback_no_generic_social.md`):
//
//   1. Identity is masked BY DEFAULT, even on `visibility = 'public'`
//      posts. The reveal happens only when the user explicitly
//      flipped `revealSender` / `revealRecipient`.
//
//   2. Visibility (`private` / `followers` / `public`) and identity
//      disclosure are ORTHOGONAL. A public post can be anonymous;
//      a followers-only post can be revealed. Compose the two
//      flags independently.
//
//   3. POSTS ARE GIFT-ANCHORED. The viewer-facing payload should
//      pull product + store from the linked Gift. When the Product
//      or Store is gone (deletion / unpublish), the post is
//      `deactivatedAt`-stamped and the helper below masks the
//      payload as `unavailable`.
//
//   4. INTERPERSONAL COUNTERS ARE GIFT-DERIVED, NOT POST-DERIVED.
//      `giftsSent` / `giftsReceived` count Gift rows regardless of
//      whether a GiftPost exists. Only the future
//      `selfPurchaseCount` will require an explicit publish to
//      increment (see `project_self_purchase_separation.md`).

export type GiftPostVisibility = 'private' | 'followers' | 'public';

export function isGiftPostVisibility(
  value: string,
): value is GiftPostVisibility {
  return value === 'private' || value === 'followers' || value === 'public';
}

// Viewer-facing payload shape. Identity fields are intentionally
// either masked tokens or null when the reveal flag is off — the
// frontend renders the product anchor regardless.
export type GiftPostView = {
  id: string;
  // Always present so the frontend can render the gifting moment
  // even when the product / store is gone.
  productName: string;
  storeName: string;
  // Set when the post is still active. Null when the linked
  // Product or Store was deleted — the UI renders a "no longer
  // available" placeholder in that case.
  productId: string | null;
  storeId: string | null;
  // Product image — single-source-of-truth URL from the linked
  // Product row. We do NOT copy the binary; the post and the
  // wishlist and any other surface that wants to render the
  // product all pull from the same pointer. Null when the post
  // is deactivated or the linked Product was deleted (matches
  // the `productId === null` projection). See
  // `project_product_media_single_source.md`.
  productImageUrl: string | null;
  // Full ordered product gallery — the GiftPost viewer's
  // horizontal swipe consumes this. Always derived from the
  // service-side `deriveGallery()` helper:
  //   - explicit ProductImage rows when present
  //   - falls back to [productImageUrl] when none exist
  //   - empty array when the product is deleted/deactivated
  // Frontend can treat `productImages` as the authoritative
  // source and ignore `productImageUrl` when length > 0.
  productImages: string[];
  // Stable URL the post links into. Empty when the post is
  // deactivated. When productId is present, the link deep-links
  // to the specific product on the store page so the viewer
  // lands directly on what was gifted, not the storefront index.
  productHref: string | null;
  // Identity slots: present + populated only when the matching
  // reveal flag is true. Otherwise null and the UI renders an
  // anonymous "Qift gifter" / "Qift recipient" placeholder.
  senderUsername: string | null;
  senderName: string | null;
  receiverUsername: string | null;
  receiverName: string | null;
  visibility: GiftPostVisibility;
  publishedAt: Date | null;
  deactivatedAt: Date | null;
};

// Inputs the post-visibility helper needs from the joined gift.
// Kept loose so the gift-service shape can grow without breaking
// this helper.
export type GiftPostInputs = {
  post: {
    id: string;
    visibility: string;
    revealSender: boolean;
    revealRecipient: boolean;
    publishedAt: Date | null;
    deactivatedAt: Date | null;
  };
  gift: {
    productName: string;
    storeName: string;
    productId: string | null;
    storeId: string | null;
    // Product image, sourced from the linked Product row at read
    // time (NOT denormalized onto Gift). Null when no Product is
    // linked (legacy / sample gifts) or when the Product was
    // deleted. The service layer does the join.
    productImageUrl: string | null;
    // Full ordered product gallery — single-source-of-truth URL
    // pointers, derived by deriveGallery() on the service side.
    productImages: string[];
    sender: { qiftUsername: string; fullName: string | null } | null;
    receiver: { qiftUsername: string; fullName: string | null } | null;
  };
  // Viewer context. The sender + receiver of a gift ALWAYS see
  // each other's identity on their OWN post (the privacy rule is
  // about the public-facing post, not the participants viewing
  // their own gifting event). `null` for unauthenticated viewers.
  viewerUserId: string | null;
  senderUserId: string;
  receiverUserId: string;
};

// Resolve the public-safe view of a GiftPost. Masks identity
// according to the reveal flags + viewer relationship; null-fills
// product / store fields when the post is deactivated.
export function buildGiftPostView(input: GiftPostInputs): GiftPostView {
  const { post, gift, viewerUserId, senderUserId, receiverUserId } = input;
  const visibility: GiftPostVisibility = isGiftPostVisibility(post.visibility)
    ? post.visibility
    : 'private';
  const deactivated = post.deactivatedAt !== null;

  const viewerIsSender = viewerUserId !== null && viewerUserId === senderUserId;
  const viewerIsReceiver =
    viewerUserId !== null && viewerUserId === receiverUserId;

  // Sender + receiver always see each other's identity on their
  // own gifting event (this is THE gift you sent / received).
  // Third-party viewers see masked tokens unless the per-side
  // reveal flag is explicitly on.
  const showSender =
    viewerIsSender || viewerIsReceiver || post.revealSender === true;
  const showReceiver =
    viewerIsSender || viewerIsReceiver || post.revealRecipient === true;

  return {
    id: post.id,
    productName: gift.productName,
    storeName: gift.storeName,
    productId: deactivated ? null : gift.productId,
    storeId: deactivated ? null : gift.storeId,
    productImageUrl: deactivated ? null : gift.productImageUrl,
    productImages: deactivated ? [] : gift.productImages,
    // Deep-link to the product when we have one (`?product=<id>` is
    // the storefront's product-modal convention; see
    // /stores/[id]/page.tsx). Falls back to the storefront index
    // when only storeId is known.
    productHref:
      deactivated || !gift.storeId
        ? null
        : gift.productId
          ? `/stores/${gift.storeId}?product=${gift.productId}`
          : `/stores/${gift.storeId}`,
    senderUsername: showSender ? (gift.sender?.qiftUsername ?? null) : null,
    senderName: showSender ? (gift.sender?.fullName ?? null) : null,
    receiverUsername: showReceiver
      ? (gift.receiver?.qiftUsername ?? null)
      : null,
    receiverName: showReceiver ? (gift.receiver?.fullName ?? null) : null,
    visibility,
    publishedAt: post.publishedAt,
    deactivatedAt: post.deactivatedAt,
  };
}

// Can `viewer` see this post on a public surface (feed, profile
// gift wall, marketplace social-proof rail)? The sender + receiver
// always see their own posts regardless of visibility. Third-party
// viewers follow the visibility setting.
//
// `followers` requires a separate follow-graph lookup at call
// time — the helper takes a boolean so this module stays free of
// Prisma dependencies. The future feed endpoint queries the
// Follow table separately and passes the result here.
export function canViewerSeePost(input: {
  post: {
    visibility: string;
    publishedAt: Date | null;
    deactivatedAt: Date | null;
  };
  viewerUserId: string | null;
  senderUserId: string;
  receiverUserId: string;
  viewerFollowsSender: boolean;
  viewerFollowsReceiver: boolean;
}): boolean {
  const { post, viewerUserId } = input;
  // Unpublished or deactivated posts are never visible to anyone
  // other than the gift parties themselves.
  if (post.deactivatedAt !== null || post.publishedAt === null) {
    return (
      viewerUserId !== null &&
      (viewerUserId === input.senderUserId ||
        viewerUserId === input.receiverUserId)
    );
  }
  if (viewerUserId === input.senderUserId) return true;
  if (viewerUserId === input.receiverUserId) return true;
  const visibility: GiftPostVisibility = isGiftPostVisibility(post.visibility)
    ? post.visibility
    : 'private';
  if (visibility === 'public') return true;
  if (visibility === 'followers') {
    return input.viewerFollowsSender || input.viewerFollowsReceiver;
  }
  return false; // private — no third-party access
}
