// Tests for canSeeOccasion — the single privacy gate for
// occasion read paths. Architecture invariant: anyone surfacing
// another user's occasion MUST route through this function. So
// every behavior covered here is load-bearing.
//
// Test matrix:
//   - owner sees their own row regardless of visibility
//   - cultural rows (userId=null) are public-only
//   - block fails closed BEFORE the visibility switch
//   - private    → only owner (already covered above)
//   - public     → anyone non-blocked
//   - followers  → viewer must follow owner (asymmetric)
//   - mutual     → both directions accepted
//   - unknown visibility → fails closed

import {
  canSeeOccasion,
  type OccasionPrivacySubject,
  type OccasionVisibility,
  type ViewerContext,
} from './occasion-privacy';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';

const ctx = (overrides: Partial<ViewerContext> = {}): ViewerContext => ({
  viewerId: VIEWER_ID,
  viewerFollowsOwner: false,
  ownerFollowsViewer: false,
  blocked: false,
  ...overrides,
});

const occ = (
  visibility: OccasionVisibility,
  userId: string | null = OWNER_ID,
): OccasionPrivacySubject => ({ userId, visibility });

describe('canSeeOccasion', () => {
  describe('owner-sees-own', () => {
    it('returns true for the owner even when visibility is private', () => {
      expect(canSeeOccasion(ctx({ viewerId: OWNER_ID }), occ('private'))).toBe(
        true,
      );
    });
    it('returns true for the owner even when "blocked" flag is set', () => {
      // Defence-in-depth: the owner branch fires BEFORE the block
      // check. A corrupted blocked-flag on the owner's own context
      // must never lock them out of their own data.
      expect(
        canSeeOccasion(
          ctx({ viewerId: OWNER_ID, blocked: true }),
          occ('private'),
        ),
      ).toBe(true);
    });
  });

  describe('cultural rows (userId === null)', () => {
    it('returns true ONLY when visibility is public', () => {
      expect(canSeeOccasion(ctx(), occ('public', null))).toBe(true);
    });
    it('returns false for cultural rows with non-public visibility', () => {
      // V1 ships cultural rows as public-by-construction; this
      // test locks down that future cultural rows with weird
      // visibility never accidentally fall back to the
      // user-tier cascade.
      expect(canSeeOccasion(ctx(), occ('private', null))).toBe(false);
      expect(canSeeOccasion(ctx(), occ('followers', null))).toBe(false);
      expect(canSeeOccasion(ctx(), occ('mutual', null))).toBe(false);
    });
  });

  describe('block-list filter', () => {
    it('returns false for a blocked viewer regardless of visibility', () => {
      const blockedCtx = ctx({ blocked: true, viewerFollowsOwner: true });
      expect(canSeeOccasion(blockedCtx, occ('public'))).toBe(false);
      expect(canSeeOccasion(blockedCtx, occ('followers'))).toBe(false);
      expect(
        canSeeOccasion(
          ctx({
            blocked: true,
            viewerFollowsOwner: true,
            ownerFollowsViewer: true,
          }),
          occ('mutual'),
        ),
      ).toBe(false);
    });
  });

  describe('visibility tier: private', () => {
    it('returns false for any non-owner viewer', () => {
      expect(canSeeOccasion(ctx(), occ('private'))).toBe(false);
      expect(
        canSeeOccasion(
          ctx({ viewerFollowsOwner: true, ownerFollowsViewer: true }),
          occ('private'),
        ),
      ).toBe(false);
    });
  });

  describe('visibility tier: public', () => {
    it('returns true for any non-blocked viewer', () => {
      expect(canSeeOccasion(ctx(), occ('public'))).toBe(true);
    });
    it('still respects the block filter', () => {
      expect(canSeeOccasion(ctx({ blocked: true }), occ('public'))).toBe(false);
    });
  });

  describe('visibility tier: followers', () => {
    it('returns true when the viewer follows the owner', () => {
      expect(
        canSeeOccasion(ctx({ viewerFollowsOwner: true }), occ('followers')),
      ).toBe(true);
    });
    it('returns false when the viewer does NOT follow the owner', () => {
      expect(canSeeOccasion(ctx(), occ('followers'))).toBe(false);
    });
    it('is asymmetric — owner-following-viewer alone is insufficient', () => {
      // The "followers" tier means "people who chose to follow
      // me", NOT "people I follow". This test locks down that
      // asymmetry — flipping it would leak data to every account
      // the owner ever followed.
      expect(
        canSeeOccasion(ctx({ ownerFollowsViewer: true }), occ('followers')),
      ).toBe(false);
    });
  });

  describe('visibility tier: mutual', () => {
    it('returns true ONLY when both follow directions are accepted', () => {
      expect(
        canSeeOccasion(
          ctx({ viewerFollowsOwner: true, ownerFollowsViewer: true }),
          occ('mutual'),
        ),
      ).toBe(true);
    });
    it('returns false when only one direction is accepted', () => {
      expect(
        canSeeOccasion(ctx({ viewerFollowsOwner: true }), occ('mutual')),
      ).toBe(false);
      expect(
        canSeeOccasion(ctx({ ownerFollowsViewer: true }), occ('mutual')),
      ).toBe(false);
    });
    it('returns false when neither direction is accepted', () => {
      expect(canSeeOccasion(ctx(), occ('mutual'))).toBe(false);
    });
  });

  describe('default-deny on unknown visibility', () => {
    it('returns false for an unrecognized visibility value', () => {
      // Cast through unknown — TypeScript would refuse the literal,
      // but a corrupted DB row CAN reach this branch at runtime.
      // Fail-closed is the only safe behavior.
      const corrupted = {
        userId: OWNER_ID,
        visibility: 'leaked-to-everyone' as unknown as OccasionVisibility,
      };
      expect(canSeeOccasion(ctx({ viewerFollowsOwner: true }), corrupted)).toBe(
        false,
      );
    });
  });
});
