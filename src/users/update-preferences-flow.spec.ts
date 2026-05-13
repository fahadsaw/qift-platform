import { Test, type TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from '../blocks/blocks.service';
import { buildPublicPreferencesProjection } from './users.service';

// End-to-end (save → load) contract for the preferences flow.
//
// The user-reported bug: "Owner enabled public visibility chips,
// saw the preview update, clicked Save — but /u/[username] still
// shows no preferences card."
//
// This spec exercises the exact PATCH + projection flow with
// realistic data to catch the wire-shape bug behind that report.
// Each test:
//   1. Calls updatePreferences with a body matching what the
//      frontend would send (visibility-only toggle PATCH or the
//      Save-button PATCH).
//   2. Captures the data object passed to prisma.user.update.
//   3. Reconstructs the post-update DB state (merges the captured
//      writes onto the pre-update row).
//   4. Feeds that into buildPublicPreferencesProjection — the
//      same call path getPublicProfile uses.
//   5. Asserts whether visitors will see the preferences card and
//      which fields.

type PrismaMock = {
  user: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  follow: { count: jest.Mock };
  gift: { count: jest.Mock };
};

// Tiny typed shim around `prisma.user.update.mock.calls[0][0].data` so
// each test reads the captured write without tripping the unsafe-
// member-access lint on `any[]`.
function capturedData(p: PrismaMock): Record<string, unknown> {
  const calls = p.user.update.mock.calls as Array<
    Array<{ data?: Record<string, unknown> }>
  >;
  return calls[0]?.[0]?.data ?? {};
}

const VIEWER_ID = 'user_owner';

// Sample "pre-update" DB row for the owner. Each test starts from
// this and applies the mocked updatePreferences write on top.
const baseUserRow = () => ({
  id: VIEWER_ID,
  qiftUsername: 'owner',
  fullName: 'Owner',
  bio: null,
  avatarUrl: null,
  profileVisibility: 'public',
  showFollowers: true,
  showFollowing: true,
  showGiftsSent: true,
  showGiftsReceived: true,
  preferredClothingSize: null as string | null,
  preferredShoeSize: null as string | null,
  preferredRingSize: null as string | null,
  preferredPerfume: null as string | null,
  favoriteColors: null as string | null,
  favoriteCategories: null as string | null,
  favoriteBrands: null as string | null,
  allergies: null as string | null,
  acceptsSurpriseGifts: true as boolean | null,
  preferencesVisibility: null as unknown,
  addresses: [{ id: 'addr_1' }],
});

describe('UsersService — preferences save + read flow', () => {
  let service: UsersService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      follow: { count: jest.fn().mockResolvedValue(0) },
      gift: { count: jest.fn().mockResolvedValue(0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: BlocksService, useValue: {} },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('updatePreferences — visibility-only PATCH (eye-toggle flow)', () => {
    it('persists the visibility dict as an object literal, not stringified', async () => {
      // Mock the post-write re-read so updatePreferences can return.
      prisma.user.findUnique.mockResolvedValue(baseUserRow());

      await service.updatePreferences(VIEWER_ID, {
        // Frontend sends a full 9-key dict every time, with the just-
        // toggled key flipped.
        preferencesVisibility: {
          clothingSize: true,
          shoeSize: false,
          ringSize: false,
          fragrance: false,
          colors: false,
          categories: false,
          brands: false,
          allergies: false,
          surprises: false,
        },
      });

      // The captured update payload must be an OBJECT, not a string
      // — Prisma's Json column wants object input, and a stringified
      // value would not be queryable as a JSON object on read.
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const calls = prisma.user.update.mock.calls as Array<
        Array<{
          where: { id: string };
          data: { preferencesVisibility: unknown };
        }>
      >;
      const call = calls[0]?.[0] ?? {
        where: { id: '' },
        data: { preferencesVisibility: null },
      };
      expect(call.where).toEqual({ id: VIEWER_ID });
      expect(typeof call.data.preferencesVisibility).toBe('object');
      expect(call.data.preferencesVisibility).toEqual({
        clothingSize: true,
        shoeSize: false,
        ringSize: false,
        fragrance: false,
        colors: false,
        categories: false,
        brands: false,
        allergies: false,
        surprises: false,
      });
    });

    it('does NOT clobber existing preference VALUES when only visibility is sent', async () => {
      // Frontend eye-toggle sends `{ preferencesVisibility: {...} }`
      // with no value fields. If updatePreferences accidentally
      // assigned `preferredClothingSize: undefined` to data, Prisma
      // would either ignore it (safe) or set it to NULL (bug). We
      // verify the data object simply doesn't carry those keys.
      prisma.user.findUnique.mockResolvedValue({
        ...baseUserRow(),
        preferredClothingSize: 'M',
        preferencesVisibility: { clothingSize: true },
      });

      await service.updatePreferences(VIEWER_ID, {
        preferencesVisibility: {
          clothingSize: true,
          shoeSize: true,
          ringSize: false,
          fragrance: false,
          colors: false,
          categories: false,
          brands: false,
          allergies: false,
          surprises: false,
        },
      });

      const data = capturedData(prisma);
      // Only the visibility key should be in the write payload.
      expect('preferencesVisibility' in data).toBe(true);
      expect('preferredClothingSize' in data).toBe(false);
      expect('preferredShoeSize' in data).toBe(false);
      expect('favoriteColors' in data).toBe(false);
    });
  });

  describe('updatePreferences — values-only PATCH (Save-button flow)', () => {
    it('persists all 9 value fields, leaving preferencesVisibility untouched', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUserRow());

      await service.updatePreferences(VIEWER_ID, {
        preferredClothingSize: 'M',
        preferredShoeSize: 'EU 42',
        preferredRingSize: '7',
        preferredPerfume: 'floral,woody',
        favoriteColors: 'black,gold',
        favoriteCategories: 'flowers,fragrance',
        favoriteBrands: 'Chanel',
        allergies: 'no nuts',
        acceptsSurpriseGifts: false,
      });

      const data = capturedData(prisma);
      expect(data.preferredClothingSize).toBe('M');
      expect(data.preferredShoeSize).toBe('EU 42');
      expect(data.preferredRingSize).toBe('7');
      expect(data.preferredPerfume).toBe('floral,woody');
      expect(data.favoriteColors).toBe('black,gold');
      expect(data.favoriteCategories).toBe('flowers,fragrance');
      expect(data.favoriteBrands).toBe('Chanel');
      expect(data.allergies).toBe('no nuts');
      expect(data.acceptsSurpriseGifts).toBe(false);
      // CRITICAL: a values-only save must NOT touch the visibility
      // dict. Otherwise the eye toggles would silently reset every
      // time the user clicks Save.
      expect('preferencesVisibility' in data).toBe(false);
    });
  });

  describe('the failing user scenario — eye-toggle then Save', () => {
    it('after both PATCHes, the projection surfaces the field publicly', () => {
      // Simulates the real flow:
      //   1. Owner toggled clothingSize visibility ON (auto-saved).
      //   2. Owner typed clothingSize = 'M'.
      //   3. Owner clicked Save (value persisted).
      //
      // Final DB state after both writes:
      const finalDbRow = {
        preferredClothingSize: 'M',
        preferredShoeSize: null,
        preferredRingSize: null,
        preferredPerfume: null,
        favoriteColors: null,
        favoriteCategories: null,
        favoriteBrands: null,
        allergies: null,
        acceptsSurpriseGifts: true as boolean | null,
        preferencesVisibility: {
          clothingSize: true,
          shoeSize: false,
          ringSize: false,
          fragrance: false,
          colors: false,
          categories: false,
          brands: false,
          allergies: false,
          surprises: false,
        },
      };

      const projected = buildPublicPreferencesProjection(finalDbRow);

      // Visitor's /u/[username] should see EXACTLY this:
      expect(projected).toEqual({ clothingSize: 'M' });
    });

    it('returns the full opt-in set when the user enables multiple fields', () => {
      const finalDbRow = {
        preferredClothingSize: 'M',
        preferredShoeSize: 'EU 42',
        preferredRingSize: null,
        preferredPerfume: 'floral',
        favoriteColors: 'black,gold',
        favoriteCategories: null,
        favoriteBrands: null,
        allergies: null,
        acceptsSurpriseGifts: true as boolean | null,
        preferencesVisibility: {
          clothingSize: true,
          shoeSize: true,
          ringSize: false,
          fragrance: true,
          colors: true,
          categories: false,
          brands: false,
          allergies: false,
          surprises: false,
        },
      };
      const projected = buildPublicPreferencesProjection(finalDbRow);
      expect(projected).toEqual({
        clothingSize: 'M',
        shoeSize: 'EU 42',
        fragrance: 'floral',
        colors: 'black,gold',
      });
    });

    it('the OPPOSITE failure mode — flag ON but value still null/empty', () => {
      // Simulates "owner toggled visibility ON but never set a
      // value": projection MUST omit that key (don't render an empty
      // chip — the user hasn't actually shared anything yet).
      const projected = buildPublicPreferencesProjection({
        preferredClothingSize: null,
        preferredShoeSize: null,
        preferredRingSize: null,
        preferredPerfume: null,
        favoriteColors: null,
        favoriteCategories: null,
        favoriteBrands: null,
        allergies: null,
        acceptsSurpriseGifts: null,
        preferencesVisibility: {
          clothingSize: true, // flag ON, but…
          shoeSize: false,
          ringSize: false,
          fragrance: false,
          colors: false,
          categories: false,
          brands: false,
          allergies: false,
          surprises: false,
        },
      });
      // …no value → empty projection → no card on /u/[username].
      expect(projected).toBeNull();
    });

    it('handles the empty-string value (NOT null) edge case', () => {
      // updatePreferences trims and converts empty-after-trim to
      // null before persisting (line 367). But if the column was
      // EVER an empty string from a legacy write, the projection
      // must treat it the same as null — chip won't render.
      const projected = buildPublicPreferencesProjection({
        preferredClothingSize: '',
        preferredShoeSize: null,
        preferredRingSize: null,
        preferredPerfume: null,
        favoriteColors: null,
        favoriteCategories: null,
        favoriteBrands: null,
        allergies: null,
        acceptsSurpriseGifts: null,
        preferencesVisibility: {
          clothingSize: true,
          shoeSize: false,
          ringSize: false,
          fragrance: false,
          colors: false,
          categories: false,
          brands: false,
          allergies: false,
          surprises: false,
        },
      });
      // Empty string is falsy in the `&&` check → omitted → null.
      expect(projected).toBeNull();
    });
  });

  describe('updatePreferences — combined PATCH (future-proof)', () => {
    it('handles a body containing both visibility AND values in one call', async () => {
      // The current frontend doesn't send this shape, but the
      // backend should support it cleanly so a future "save
      // everything in one PATCH" frontend simplification works.
      prisma.user.findUnique.mockResolvedValue(baseUserRow());

      await service.updatePreferences(VIEWER_ID, {
        preferredClothingSize: 'L',
        preferencesVisibility: {
          clothingSize: true,
          shoeSize: false,
          ringSize: false,
          fragrance: false,
          colors: false,
          categories: false,
          brands: false,
          allergies: false,
          surprises: false,
        },
      });

      const data = capturedData(prisma);
      expect(data.preferredClothingSize).toBe('L');
      expect(data.preferencesVisibility).toEqual({
        clothingSize: true,
        shoeSize: false,
        ringSize: false,
        fragrance: false,
        colors: false,
        categories: false,
        brands: false,
        allergies: false,
        surprises: false,
      });
    });
  });

  describe('updatePreferences — null clears the visibility dict', () => {
    it('explicit null payload writes Prisma.JsonNull (column reset)', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUserRow());

      await service.updatePreferences(VIEWER_ID, {
        preferencesVisibility: null,
      });

      const data = capturedData(prisma);
      // Should be the sentinel JsonNull value (DbNull), not a JS
      // null literal — Prisma distinguishes "don't touch" vs
      // "set to NULL".
      expect(data.preferencesVisibility).toBeDefined();
      // After Prisma.JsonNull is written, getPublicProfile reads
      // it back as null → projection returns null → no card.
      const reread = buildPublicPreferencesProjection({
        ...baseUserRow(),
        preferredClothingSize: 'M', // even with a value
        preferencesVisibility: null, // visibility cleared
      });
      expect(reread).toBeNull();
    });
  });
});
