import {
  projectStorefrontMetrics,
  TRENDING_WINDOW_MS,
} from './storefront-metrics';

// Helper — build a minimal MetricSource. Each test extends only
// what it asserts on so the contract stays explicit.
const source = (
  partial: Partial<Parameters<typeof projectStorefrontMetrics>[0]> = {},
) => ({
  wishlistedByCount: null,
  giftedByCount: null,
  trendingAt: null,
  ...partial,
});

describe('projectStorefrontMetrics', () => {
  describe('default-deny visibility handling', () => {
    it('returns undefined for null visibility (column NEVER written)', () => {
      // Default-deny is the architectural invariant — a fresh
      // merchant with no opted-in keys must surface ZERO metrics
      // even when every counter has real data.
      const out = projectStorefrontMetrics(
        source({
          wishlistedByCount: 42,
          giftedByCount: 9,
          trendingAt: new Date(),
        }),
        null,
      );
      expect(out).toBeUndefined();
    });

    it('returns undefined for empty {} visibility', () => {
      const out = projectStorefrontMetrics(
        source({ wishlistedByCount: 42 }),
        {},
      );
      expect(out).toBeUndefined();
    });

    it('returns undefined for malformed (non-object) visibility', () => {
      // readMetricsVisibility coerces malformed input to all-hidden;
      // this guards against a corrupted JSON column.
      const out = projectStorefrontMetrics(
        source({ wishlistedByCount: 42 }),
        'not-an-object',
      );
      expect(out).toBeUndefined();
    });

    it('ignores unknown keys in visibility (forward-compat)', () => {
      // The METRICS_VISIBILITY_KEYS allow-list is authoritative;
      // a key the merchant somehow ended up with that we don't
      // recognize must NOT leak ANY metric.
      const out = projectStorefrontMetrics(source({ wishlistedByCount: 42 }), {
        totallyMadeUpKey: true,
      });
      expect(out).toBeUndefined();
    });
  });

  describe('wishlistSaves', () => {
    it('returns the count when opted in', () => {
      const out = projectStorefrontMetrics(source({ wishlistedByCount: 7 }), {
        wishlistSaves: true,
      });
      expect(out).toEqual({ wishlistSaves: 7 });
    });

    it('is OMITTED (not zero) when opted in but source is null', () => {
      // A null source means "we don't have a value" — the chip
      // shouldn't render at all (vs rendering "0", which would
      // imply the merchant has 0 wishlist saves on a brand-new
      // product).
      const out = projectStorefrontMetrics(
        source({ wishlistedByCount: null }),
        { wishlistSaves: true },
      );
      expect(out).toBeUndefined();
    });

    it('clamps a negative counter to 0', () => {
      // A counter regression bug upstream shouldn't surface as
      // "-2 wishlisted" on the storefront.
      const out = projectStorefrontMetrics(source({ wishlistedByCount: -2 }), {
        wishlistSaves: true,
      });
      expect(out).toEqual({ wishlistSaves: 0 });
    });

    it('does NOT surface even when source has a value if visibility is off', () => {
      // This is THE leak test. The merchant explicitly opted
      // wishlistSaves OFF — the wire must never carry the value,
      // even though the source has 1000.
      const out = projectStorefrontMetrics(
        source({ wishlistedByCount: 1000 }),
        { wishlistSaves: false, giftedCount: true /* unrelated */ },
      );
      expect(out).toBeUndefined();
    });
  });

  describe('giftedCount', () => {
    it('returns the count when opted in', () => {
      const out = projectStorefrontMetrics(source({ giftedByCount: 12 }), {
        giftedCount: true,
      });
      expect(out).toEqual({ giftedCount: 12 });
    });

    it('NEVER leaks when visibility is off', () => {
      const out = projectStorefrontMetrics(source({ giftedByCount: 999 }), {
        wishlistSaves: true,
      });
      // wishlistedByCount source is null → that key omitted; gift
      // count source is 999 BUT NOT OPTED IN → ALSO omitted.
      expect(out).toBeUndefined();
    });
  });

  describe('trendingIndicator', () => {
    it('returns true when trendingAt is within the window', () => {
      const now = new Date('2026-05-13T12:00:00Z');
      const recent = new Date(now.getTime() - TRENDING_WINDOW_MS / 2);
      const out = projectStorefrontMetrics(
        source({ trendingAt: recent }),
        { trendingIndicator: true },
        now,
      );
      expect(out).toEqual({ trendingIndicator: true });
    });

    it('returns false when trendingAt has aged out', () => {
      const now = new Date('2026-05-13T12:00:00Z');
      const old = new Date(now.getTime() - TRENDING_WINDOW_MS - 1);
      const out = projectStorefrontMetrics(
        source({ trendingAt: old }),
        { trendingIndicator: true },
        now,
      );
      expect(out).toEqual({ trendingIndicator: false });
    });

    it('returns false when trendingAt is null', () => {
      const out = projectStorefrontMetrics(source({ trendingAt: null }), {
        trendingIndicator: true,
      });
      expect(out).toEqual({ trendingIndicator: false });
    });

    it('does NOT surface when visibility is off', () => {
      const out = projectStorefrontMetrics(source({ trendingAt: new Date() }), {
        trendingIndicator: false,
      });
      expect(out).toBeUndefined();
    });
  });

  describe('unknown keys (dropped from V1 allow-list)', () => {
    it('keys not in METRICS_VISIBILITY_KEYS are silently dropped', () => {
      // V1 dropped purchaseCount / soldCount / stockCount /
      // ratingsCount / popularityScore from the allow-list (see
      // storefront-themes.ts for the philosophy). A merchant who
      // somehow gets one of these keys into their stored dict
      // (e.g. from a pre-trim cache) must NOT have it surface.
      const out = projectStorefrontMetrics(source({ wishlistedByCount: 5 }), {
        purchaseCount: true,
        soldCount: true,
        stockCount: true,
        ratingsCount: true,
        popularityScore: true,
      });
      // readMetricsVisibility filters to METRICS_VISIBILITY_KEYS,
      // so none of the dropped keys propagate. With no recognized
      // key opted in, the projection returns undefined.
      expect(out).toBeUndefined();
    });

    it('returns ONLY the recognized opted-in keys when both kinds are mixed', () => {
      const out = projectStorefrontMetrics(
        source({ wishlistedByCount: 5, giftedByCount: 3 }),
        {
          wishlistSaves: true,
          giftedCount: true,
          purchaseCount: true /* dropped from allow-list */,
        },
      );
      expect(out).toEqual({ wishlistSaves: 5, giftedCount: 3 });
      // Specifically, purchaseCount is NOT a key on the result.
      expect(out && 'purchaseCount' in out).toBe(false);
    });
  });

  describe('multiple keys', () => {
    it('returns each opted-in sourced key, omits the rest', () => {
      const out = projectStorefrontMetrics(
        source({
          wishlistedByCount: 5,
          giftedByCount: 3,
          trendingAt: new Date(),
        }),
        {
          wishlistSaves: true,
          giftedCount: true,
          trendingIndicator: true,
        },
      );
      expect(out).toEqual({
        wishlistSaves: 5,
        giftedCount: 3,
        trendingIndicator: true,
      });
    });

    it('partial-opt-in shows only those keys', () => {
      const out = projectStorefrontMetrics(
        source({
          wishlistedByCount: 5,
          giftedByCount: 3,
          trendingAt: new Date(),
        }),
        { wishlistSaves: true /* others off */ },
      );
      expect(out).toEqual({ wishlistSaves: 5 });
      expect(out && 'giftedCount' in out).toBe(false);
      expect(out && 'trendingIndicator' in out).toBe(false);
    });
  });

  describe('leak invariant (the big architectural promise)', () => {
    // This is the test that justifies the whole projection layer.
    // For every combination of (visibility OFF, source present),
    // the wire MUST NOT carry the value.
    const RICH_SOURCE = {
      wishlistedByCount: 100,
      giftedByCount: 50,
      trendingAt: new Date(),
    };

    it('default-deny: no visibility → no metrics, no matter how rich the source', () => {
      const out = projectStorefrontMetrics(RICH_SOURCE, null);
      expect(out).toBeUndefined();
    });

    it('every-key-OFF: explicit false flags → no metrics', () => {
      const out = projectStorefrontMetrics(RICH_SOURCE, {
        wishlistSaves: false,
        giftedCount: false,
        trendingIndicator: false,
      });
      expect(out).toBeUndefined();
    });

    it('coerces non-true values to false (no truthy-but-not-true bypass)', () => {
      // readMetricsVisibility uses strict === true; this guards
      // against a misconfigured client sending 1 / "yes" / etc.
      // and accidentally enabling a metric.
      const out = projectStorefrontMetrics(RICH_SOURCE, {
        wishlistSaves: 1 as unknown as boolean,
        giftedCount: 'yes' as unknown as boolean,
        trendingIndicator: {} as unknown as boolean,
      });
      expect(out).toBeUndefined();
    });
  });
});
