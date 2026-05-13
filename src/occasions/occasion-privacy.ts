// Privacy gate for occasion read paths. Single enforcement point —
// every public-facing read in OccasionsService routes through
// `canSeeOccasion()`. Architecture doc Section 6.
//
// Pure logic — no Prisma. The caller supplies the relationship
// facts (follow edges, block status); this function decides.

export type OccasionVisibility = 'private' | 'followers' | 'mutual' | 'public';

export type OccasionPrivacySubject = {
  // Owner of the occasion row.
  userId: string | null;
  visibility: OccasionVisibility;
};

export type ViewerContext = {
  viewerId: string;
  // Does the viewer follow the occasion owner (accepted)?
  viewerFollowsOwner: boolean;
  // Does the occasion owner follow the viewer (accepted)?
  ownerFollowsViewer: boolean;
  // Is either side blocked (either direction)? When true the
  // viewer is denied access REGARDLESS of visibility tier.
  blocked: boolean;
};

export function canSeeOccasion(
  viewer: ViewerContext,
  occasion: OccasionPrivacySubject,
): boolean {
  // Owner always sees their own occasions, regardless of
  // visibility setting. (Architecture doc Section 6.2.)
  if (occasion.userId && viewer.viewerId === occasion.userId) {
    return true;
  }

  // Cultural / platform-defined rows (userId === null). V1
  // doesn't ship these but the column allows them; when they
  // arrive they're public-by-construction (the existence of
  // Eid is universal). Architecture doc Section 6.5.
  if (occasion.userId === null) {
    return occasion.visibility === 'public';
  }

  // Block-list filter — applies BEFORE visibility tier. A
  // blocked viewer can't see ANY of the owner's occasions even
  // if the tier would otherwise allow it. Same shape as the
  // GiftPost / public-profile block filter.
  if (viewer.blocked) return false;

  switch (occasion.visibility) {
    case 'private':
      return false;
    case 'public':
      return true;
    case 'followers':
      // The viewer must follow the owner. Asymmetric on purpose:
      // followers-only means "people who chose to follow me",
      // not "people I follow".
      return viewer.viewerFollowsOwner;
    case 'mutual':
      // Both directions of follow must be accepted. The strictest
      // tier short of fully private.
      return viewer.viewerFollowsOwner && viewer.ownerFollowsViewer;
    default:
      // Unknown visibility value — fail closed. A corrupted row
      // never accidentally leaks.
      return false;
  }
}
