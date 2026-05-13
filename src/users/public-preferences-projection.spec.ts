import {
  buildPublicPreferencesProjection,
  type OwnerPreferences,
} from './users.service';

// Privacy contract for the public-profile preferences projection.
//
// This is the helper getPublicProfile calls to decide which owner
// preferences reach a third-party viewer. It is THE enforcement
// boundary: every read path that surfaces another user's
// preferences runs through this function, so its behaviour is
// security-critical.
//
// Tests below cover:
//   1. Default-deny: a null / undefined / malformed visibility
//      dict surfaces NOTHING.
//   2. Per-field opt-in: each visibility flag controls exactly its
//      own field; setting one does NOT leak others.
//   3. Strict-true coercion: truthy-but-not-true values
//      (`"yes"`, `1`, `{}`) do NOT enable a field.
//   4. Missing source: a flag set true with a null source value
//      omits the field entirely (no empty key on the wire).
//   5. Verification scenario from the user spec:
//      "User A enables public clothing size + fragrance.
//       User B should see ONLY those two fields."

const fullSource = (visibility: unknown): OwnerPreferences => ({
  preferredClothingSize: 'M',
  preferredShoeSize: 'EU 42',
  preferredRingSize: '7',
  preferredPerfume: 'floral,woody',
  favoriteColors: 'black,gold',
  favoriteCategories: 'flowers,fragrance',
  favoriteBrands: 'Chanel',
  allergies: 'no nuts',
  acceptsSurpriseGifts: false,
  preferencesVisibility: visibility,
});

describe('buildPublicPreferencesProjection', () => {
  describe('default-deny', () => {
    it('returns null when visibility dict is null', () => {
      expect(buildPublicPreferencesProjection(fullSource(null))).toBeNull();
    });

    it('returns null when visibility dict is undefined', () => {
      expect(
        buildPublicPreferencesProjection(fullSource(undefined)),
      ).toBeNull();
    });

    it('returns null when visibility dict is malformed (non-object)', () => {
      // JSON column drift could land as a string after a bad
      // write; defensive fallback is all-private.
      expect(
        buildPublicPreferencesProjection(fullSource('not an object')),
      ).toBeNull();
    });

    it('returns null when every flag is explicitly false', () => {
      const allFalse = {
        clothingSize: false,
        shoeSize: false,
        ringSize: false,
        fragrance: false,
        colors: false,
        categories: false,
        brands: false,
        allergies: false,
        surprises: false,
      };
      expect(buildPublicPreferencesProjection(fullSource(allFalse))).toBeNull();
    });

    it('returns null when the dict only carries UNKNOWN keys', () => {
      // A misconfigured client somehow stored a key not in the
      // allow-list. Must NOT leak anything.
      expect(
        buildPublicPreferencesProjection(
          fullSource({
            notARealField: true,
            anotherInvented: true,
          }),
        ),
      ).toBeNull();
    });
  });

  describe('per-field opt-in', () => {
    it('opting in clothingSize surfaces ONLY clothingSize', () => {
      const out = buildPublicPreferencesProjection(
        fullSource({ clothingSize: true }),
      );
      expect(out).toEqual({ clothingSize: 'M' });
      // No other fields, even though every source field has a value.
      expect(out && 'shoeSize' in out).toBe(false);
      expect(out && 'fragrance' in out).toBe(false);
      expect(out && 'allergies' in out).toBe(false);
      expect(out && 'acceptsSurpriseGifts' in out).toBe(false);
    });

    it('opting in surprises ALWAYS includes the boolean (even false)', () => {
      // Surprise acceptance is a meaningful signal in both directions
      // — opting in to show "false" is itself useful information.
      const out = buildPublicPreferencesProjection(
        fullSource({ surprises: true }),
      );
      expect(out).toEqual({ acceptsSurpriseGifts: false });
    });

    it('opting in surprises with null source defaults to true', () => {
      const owner: OwnerPreferences = {
        ...fullSource({ surprises: true }),
        acceptsSurpriseGifts: null,
      };
      const out = buildPublicPreferencesProjection(owner);
      // Null underlying value reads as "true" by default — same
      // convention as the owner's /preferences page initial state.
      expect(out).toEqual({ acceptsSurpriseGifts: true });
    });
  });

  describe('strict-true coercion', () => {
    it('a string "true" does NOT enable a field', () => {
      const out = buildPublicPreferencesProjection(
        fullSource({ clothingSize: 'true' }),
      );
      expect(out).toBeNull();
    });

    it('a numeric 1 does NOT enable a field', () => {
      const out = buildPublicPreferencesProjection(
        fullSource({ clothingSize: 1 }),
      );
      expect(out).toBeNull();
    });

    it('an object {} does NOT enable a field', () => {
      const out = buildPublicPreferencesProjection(
        fullSource({ clothingSize: {} }),
      );
      expect(out).toBeNull();
    });
  });

  describe('missing source value', () => {
    it('opting in a flag with null source omits the key entirely', () => {
      // Distinguish "the merchant opted in but hasn't set a value
      // yet" from "the merchant has a value but opted out". The
      // former renders no chip; the latter is impossible (visibility
      // gates the value before the wire).
      const owner: OwnerPreferences = {
        ...fullSource({ clothingSize: true, shoeSize: true }),
        preferredClothingSize: null,
      };
      const out = buildPublicPreferencesProjection(owner);
      expect(out).toEqual({ shoeSize: 'EU 42' });
      expect(out && 'clothingSize' in out).toBe(false);
    });
  });

  describe('the user-spec verification scenario', () => {
    it('User A enables clothingSize + fragrance only → viewer sees ONLY those two', () => {
      // From the user direction:
      //   "User A enables public clothing size + fragrance preferences.
      //    User B opens /u/A.
      //    User B sees ONLY the allowed fields.
      //    User B does NOT see hidden/private fields."
      const out = buildPublicPreferencesProjection(
        fullSource({
          clothingSize: true,
          fragrance: true,
          // every other flag deliberately absent (treated as false)
        }),
      );
      // Exactly the two opted-in fields, with their canonical values.
      expect(out).toEqual({
        clothingSize: 'M',
        fragrance: 'floral,woody',
      });
      // None of the other 7 fields leak — this is the leak test.
      expect(out && 'shoeSize' in out).toBe(false);
      expect(out && 'ringSize' in out).toBe(false);
      expect(out && 'colors' in out).toBe(false);
      expect(out && 'categories' in out).toBe(false);
      expect(out && 'brands' in out).toBe(false);
      expect(out && 'allergies' in out).toBe(false);
      expect(out && 'acceptsSurpriseGifts' in out).toBe(false);
    });
  });

  describe('the architectural leak invariant', () => {
    // For EVERY combination of (visibility OFF, source has rich
    // value), the projection MUST omit the field. This is the
    // contract that justifies the projection layer existing at all.
    const RICH = fullSource(null);

    it('a rich source paired with null visibility = empty projection', () => {
      expect(buildPublicPreferencesProjection(RICH)).toBeNull();
    });

    it('flipping ONE flag never accidentally drags neighbours along', () => {
      // Pairwise: enable each key in isolation, verify only that
      // key's projected output appears.
      const cases: {
        flag: string;
        expected: Record<string, unknown>;
      }[] = [
        { flag: 'clothingSize', expected: { clothingSize: 'M' } },
        { flag: 'shoeSize', expected: { shoeSize: 'EU 42' } },
        { flag: 'ringSize', expected: { ringSize: '7' } },
        { flag: 'fragrance', expected: { fragrance: 'floral,woody' } },
        { flag: 'colors', expected: { colors: 'black,gold' } },
        {
          flag: 'categories',
          expected: { categories: 'flowers,fragrance' },
        },
        { flag: 'brands', expected: { brands: 'Chanel' } },
        { flag: 'allergies', expected: { allergies: 'no nuts' } },
        {
          flag: 'surprises',
          expected: { acceptsSurpriseGifts: false },
        },
      ];
      for (const c of cases) {
        const out = buildPublicPreferencesProjection(
          fullSource({ [c.flag]: true }),
        );
        expect(out).toEqual(c.expected);
      }
    });
  });
});
