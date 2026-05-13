// StoresService — Phase 5 theme + visibility behaviors.
//
// Verifies the architectural contracts from
// `project_storefront_architecture.md`:
//   - Plan-gated theme selection (server-side enforcement)
//   - Bounded themeConfig sanitization (allow-list)
//   - Per-metric visibility opt-in (default all-hidden)
//   - Downgrade-safe resolution (resolveActiveTheme falls back)
//
// We mock PrismaService directly so the tests stay deterministic.
// The behavior under test is plan-gating logic + sanitization shape
// — both pure of DB semantics.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StoresService } from './stores.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  isThemeEligible,
  resolveActiveTheme,
  sanitizeThemeConfig,
  sanitizeMetricsVisibility,
  readMetricsVisibility,
} from './storefront-themes';

type MockPrisma = {
  store: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

function createPrismaMock(): MockPrisma {
  return {
    store: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

describe('Storefront themes — pure helpers', () => {
  describe('isThemeEligible', () => {
    it('allows classic on every plan', () => {
      expect(isThemeEligible('starter', 'classic')).toBe(true);
      expect(isThemeEligible('pro', 'classic')).toBe(true);
      expect(isThemeEligible('enterprise', 'classic')).toBe(true);
    });

    it('gates gallery to pro+', () => {
      expect(isThemeEligible('starter', 'gallery')).toBe(false);
      expect(isThemeEligible('pro', 'gallery')).toBe(true);
      expect(isThemeEligible('enterprise', 'gallery')).toBe(true);
    });

    it('gates editorial to enterprise only', () => {
      expect(isThemeEligible('starter', 'editorial')).toBe(false);
      expect(isThemeEligible('pro', 'editorial')).toBe(false);
      expect(isThemeEligible('enterprise', 'editorial')).toBe(true);
    });
  });

  describe('resolveActiveTheme', () => {
    it('returns the stored slug when the plan covers it', () => {
      expect(resolveActiveTheme('gallery', 'pro')).toBe('gallery');
      expect(resolveActiveTheme('editorial', 'enterprise')).toBe('editorial');
    });

    it('falls back to classic on plan downgrade', () => {
      // Merchant chose gallery on Pro, then was downgraded to Starter.
      // Render-time resolution returns classic; the stored value is
      // intentionally NOT mutated by this helper (caller decides).
      expect(resolveActiveTheme('gallery', 'starter')).toBe('classic');
      expect(resolveActiveTheme('editorial', 'pro')).toBe('classic');
    });

    it('falls back to classic on an unknown stored slug', () => {
      expect(resolveActiveTheme('totally-fake-theme', 'enterprise')).toBe(
        'classic',
      );
    });
  });

  describe('sanitizeThemeConfig', () => {
    it('returns null for null / undefined / non-objects', () => {
      expect(sanitizeThemeConfig(null)).toBeNull();
      expect(sanitizeThemeConfig(undefined)).toBeNull();
      expect(sanitizeThemeConfig('hello')).toBeNull();
      expect(sanitizeThemeConfig(42)).toBeNull();
    });

    it('accepts known curated accent colors and drops unknown hex', () => {
      const ok = sanitizeThemeConfig({ accentColor: '#7B5CF5' });
      expect(ok?.accentColor).toBe('#7B5CF5');
      // Free-form hex (not in the palette) silently dropped.
      const bad = sanitizeThemeConfig({ accentColor: '#FF0000' });
      expect(bad).toBeNull();
    });

    it('accepts https URLs for bannerImageUrl and rejects javascript: URLs', () => {
      const ok = sanitizeThemeConfig({
        bannerImageUrl: 'https://r2.qift.app/banner.jpg',
      });
      expect(ok?.bannerImageUrl).toBe('https://r2.qift.app/banner.jpg');
      // Defensive: a javascript: URL slips past the regex check.
      const bad = sanitizeThemeConfig({
        bannerImageUrl: 'javascript:alert(1)',
      });
      expect(bad).toBeNull();
    });

    it('caps headline + subhead lengths', () => {
      const ok = sanitizeThemeConfig({
        heroHeadline: 'A'.repeat(80),
        heroSubhead: 'B'.repeat(160),
      });
      expect(ok?.heroHeadline?.length).toBe(80);
      expect(ok?.heroSubhead?.length).toBe(160);
      // Over-cap values are dropped (not truncated) so the bound is
      // unambiguous to the caller.
      const tooLong = sanitizeThemeConfig({
        heroHeadline: 'A'.repeat(81),
        heroSubhead: 'B'.repeat(161),
      });
      expect(tooLong).toBeNull();
    });

    it('silently drops unknown keys (forward-compat)', () => {
      const out = sanitizeThemeConfig({
        accentColor: '#7B5CF5',
        unknownKey: 'evil',
        anotherFakeKey: { nested: true },
      });
      expect(out).toEqual({ accentColor: '#7B5CF5' });
    });
  });

  describe('sanitizeMetricsVisibility', () => {
    it('returns null when no keys are set', () => {
      expect(sanitizeMetricsVisibility({})).toBeNull();
      expect(sanitizeMetricsVisibility(null)).toBeNull();
    });

    it('coerces known keys to strict booleans, drops unknown', () => {
      const out = sanitizeMetricsVisibility({
        wishlistSaves: true,
        purchaseCount: 'yes', // truthy string but NOT strict true
        unknownMetric: true,
      });
      // wishlistSaves is true; purchaseCount becomes false (strict !== true);
      // unknownMetric silently dropped.
      expect(out).toEqual({
        wishlistSaves: true,
        purchaseCount: false,
      });
    });

    it('readMetricsVisibility tolerates malformed DB rows as all-false', () => {
      // JSON column drift / pre-migration row could land as null or
      // a non-object — fall through to all-false.
      const out1 = readMetricsVisibility(null);
      const out2 = readMetricsVisibility('not an object');
      for (const out of [out1, out2]) {
        expect(out.wishlistSaves).toBe(false);
        expect(out.purchaseCount).toBe(false);
        expect(out.giftedCount).toBe(false);
        expect(out.popularityScore).toBe(false);
        expect(out.ratingsCount).toBe(false);
        expect(out.stockCount).toBe(false);
        expect(out.soldCount).toBe(false);
        expect(out.trendingIndicator).toBe(false);
      }
    });
  });
});

// ── StoresService service-level tests ──────────────────────────
//
// Focused tests on the new setStoreTheme + setStoreMetricsVisibility
// paths. The existing setPlan / capability / approval methods are
// covered indirectly through admin/integration tests; this spec is
// scoped to the Phase 5 additions.

describe('StoresService — Phase 5 (theme + visibility)', () => {
  let service: StoresService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [StoresService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<StoresService>(StoresService);
  });

  // assertOwner is called first; mock it to pass through. We test
  // plan-gating in isolation by setting up the post-assertOwner
  // store row and observing the update payload.
  function mockOwned(plan: string, themeSlug = 'classic') {
    // assertOwner does a findFirst on Store; the helper exists in
    // stores.service.ts so we mock the findUnique fallthrough for
    // the post-assertOwner store-load too. Both calls land on the
    // same Prisma findUnique mock.
    prisma.store.findUnique.mockResolvedValue({
      id: 'store_a',
      ownerId: 'owner_1',
      plan,
      themeSlug,
    });
  }

  describe('setStoreTheme', () => {
    it('rejects an unknown theme slug', async () => {
      mockOwned('enterprise');
      // assertOwner reads via prisma.store.findFirst — patch a
      // shortcut by spying on the service's own assertion method.
      // We mock findUnique to satisfy both the assertOwner probe
      // (some implementations use findUnique) and the post-assert
      // store load. Either way, an unknown slug rejects BEFORE
      // anything touches the DB beyond the plan read.
      const owner = jest
        .spyOn(service, 'assertOwner')
        .mockResolvedValue({ id: 'store_a', ownerId: 'owner_1', status: 'active' });
      await expect(
        service.setStoreTheme('owner_1', 'store_a', {
          themeSlug: 'totally-fake-theme',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.store.update).not.toHaveBeenCalled();
      owner.mockRestore();
    });

    it('rejects a theme that requires a higher plan than the store has', async () => {
      mockOwned('starter');
      jest.spyOn(service, 'assertOwner').mockResolvedValue({ id: 'store_a', ownerId: 'owner_1', status: 'active' });
      // Gallery requires Pro+; starter merchant tries → 403.
      await expect(
        service.setStoreTheme('owner_1', 'store_a', { themeSlug: 'gallery' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.store.update).not.toHaveBeenCalled();
    });

    it('persists themeSlug + sanitized themeConfig when both plan and config are valid', async () => {
      mockOwned('enterprise');
      jest.spyOn(service, 'assertOwner').mockResolvedValue({ id: 'store_a', ownerId: 'owner_1', status: 'active' });
      prisma.store.update.mockResolvedValue({
        id: 'store_a',
        themeSlug: 'editorial',
        themeConfig: { accentColor: '#7B5CF5' },
      });

      await service.setStoreTheme('owner_1', 'store_a', {
        themeSlug: 'editorial',
        themeConfig: {
          accentColor: '#7B5CF5',
          // Unknown keys must be dropped by sanitization.
          unknownKey: 'evil',
        },
      });

      expect(prisma.store.update).toHaveBeenCalledTimes(1);
      const data = prisma.store.update.mock.calls[0][0].data;
      expect(data.themeSlug).toBe('editorial');
      // Sanitized config contains ONLY the known accentColor.
      expect(data.themeConfig).toEqual({ accentColor: '#7B5CF5' });
    });

    it('clears themeConfig when null is passed', async () => {
      mockOwned('pro');
      jest.spyOn(service, 'assertOwner').mockResolvedValue({ id: 'store_a', ownerId: 'owner_1', status: 'active' });
      prisma.store.update.mockResolvedValue({});

      await service.setStoreTheme('owner_1', 'store_a', {
        themeConfig: null,
      });

      const data = prisma.store.update.mock.calls[0][0].data;
      // Prisma.JsonNull is the canonical "set JSON column to NULL"
      // payload. Direct equality is the cleanest assertion.
      expect(data.themeConfig).toBe(Prisma.JsonNull);
    });
  });

  describe('setStoreMetricsVisibility', () => {
    it('persists only known keys with strict-boolean values', async () => {
      mockOwned('starter');
      jest.spyOn(service, 'assertOwner').mockResolvedValue({ id: 'store_a', ownerId: 'owner_1', status: 'active' });
      prisma.store.update.mockResolvedValue({});

      await service.setStoreMetricsVisibility('owner_1', 'store_a', {
        wishlistSaves: true,
        unknownMetric: true,
        // truthy non-true coerces to false (strict bool)
        purchaseCount: 'yes',
      });

      const data = prisma.store.update.mock.calls[0][0].data;
      expect(data.metricsVisibility).toEqual({
        wishlistSaves: true,
        purchaseCount: false,
      });
    });

    it('clears the column when nothing is opted in', async () => {
      mockOwned('starter');
      jest.spyOn(service, 'assertOwner').mockResolvedValue({ id: 'store_a', ownerId: 'owner_1', status: 'active' });
      prisma.store.update.mockResolvedValue({});

      await service.setStoreMetricsVisibility('owner_1', 'store_a', {});

      const data = prisma.store.update.mock.calls[0][0].data;
      // Empty dict → sanitize returns null → DB column gets the
      // Prisma.JsonNull sentinel → column stays NULL on disk →
      // readMetricsVisibility treats it as all-hidden.
      expect(data.metricsVisibility).toBe(Prisma.JsonNull);
    });
  });
});
