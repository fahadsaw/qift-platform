// Storefront metrics projection — the enforcement boundary for
// per-product, per-merchant visibility.
//
// Architectural contract:
//
//   1. This helper is the SINGLE place where raw counter values
//      are converted into the merchant-approved subset that
//      reaches the wire. Nothing downstream (theme, primitive,
//      frontend adapter) is allowed to read the raw counters.
//
//   2. The output is a sparse dict: ONLY the keys the merchant
//      explicitly opted into (via Store.metricsVisibility) are
//      present. Missing keys = hidden. The frontend
//      <MetricChip> primitive guards on undefined as well, so
//      defense-in-depth: even a future bug here can't surface a
//      hidden metric.
//
//   3. Default-deny. A null / empty / malformed visibility dict
//      reads as ALL HIDDEN. The merchant must explicitly turn
//      each key on (mirrors User.preferencesVisibility — same
//      opt-in basis).
//
// V1 metric sources:
//
//   wishlistSaves      → Product.wishlistedByCount (denormalized)
//   giftedCount        → Product.giftedByCount (denormalized)
//   trendingIndicator  → Product.trendingAt within TRENDING_WINDOW
//   {other keys}       → no source yet; the projection NEVER ships
//                        the key (so the visibility dashboard can
//                        already toggle them on without a leak
//                        risk; once a source lands, the chip
//                        starts rendering automatically).
//
// See `project_storefront_architecture.md` Section 11 +
// `apps/api/src/stores/storefront-themes.ts`
// (METRICS_VISIBILITY_KEYS).

import type { MetricsVisibilityKey } from '../stores/storefront-themes';
import { readMetricsVisibility } from '../stores/storefront-themes';

// How recent counts as "trending". Tuned for V1 — short enough
// that a stale trendingAt timestamp doesn't keep a no-longer-hot
// product flagged; long enough that an active product stays
// flagged across the engagement curve.
export const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Heart-velocity threshold. Once a product reaches this many
// distinct wishlistedByCount, every NEW heart bumps trendingAt
// (so a recently-engaged product surfaces). Below this bar we
// don't update trendingAt — keeps "trending" from triggering on
// brand-new products with a single heart.
export const TRENDING_HEART_THRESHOLD = 3;

// What the projection writes onto the wire. Sparse — every key
// is optional. Matches the frontend type literally so adapters
// stay one-line.
export type ProjectedMetrics = {
  wishlistSaves?: number;
  purchaseCount?: number;
  giftedCount?: number;
  popularityScore?: number;
  ratingsCount?: number;
  stockCount?: number;
  soldCount?: number;
  trendingIndicator?: boolean;
};

// Shape this helper expects. Permissive — callers can pass the
// full Product row (Prisma's typed result) or a narrow subset;
// the helper only reads the columns it needs.
export type MetricSource = {
  wishlistedByCount?: number | null;
  giftedByCount?: number | null;
  trendingAt?: Date | null;
};

// Project a single product's metrics through the merchant's
// visibility dict. Returns `undefined` when nothing is opted in
// so callers can skip the field entirely on the wire (smaller
// payload + a clear "no metrics" signal at the type level).
export function projectStorefrontMetrics(
  source: MetricSource,
  visibilityRaw: unknown,
  now: Date = new Date(),
): ProjectedMetrics | undefined {
  // readMetricsVisibility coerces null/empty/malformed input to
  // an all-false dict so default-deny is automatic.
  const visibility = readMetricsVisibility(visibilityRaw);

  // Walk every recognized key. Centralizes the "is this key
  // sourced AND opted in?" decision so adding a new metric is
  // one switch arm.
  const out: ProjectedMetrics = {};

  for (const key of Object.keys(visibility) as MetricsVisibilityKey[]) {
    if (!visibility[key]) continue;
    const value = resolveMetricValue(key, source, now);
    if (value !== undefined) {
      // Type assertion is safe — resolveMetricValue's return
      // matches ProjectedMetrics[key] by construction.
      (out as Record<string, number | boolean>)[key] = value;
    }
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

// Single-key resolver. Returns the projected value (number or
// boolean) when a source exists; returns undefined when the
// metric isn't yet wired up. Hidden keys never reach this
// function — `projectStorefrontMetrics` gates on visibility
// before calling.
function resolveMetricValue(
  key: MetricsVisibilityKey,
  source: MetricSource,
  now: Date,
): number | boolean | undefined {
  switch (key) {
    case 'wishlistSaves':
      // Source: Product.wishlistedByCount (denormalized, kept in
      // lockstep with the Wish table by WishesService).
      return clampNonNegative(source.wishlistedByCount);

    case 'giftedCount':
      // Source: Product.giftedByCount (denormalized, incremented
      // by GiftsService.create when productId is set; backfilled
      // from existing Gift rows in the 20260519 migration).
      return clampNonNegative(source.giftedByCount);

    case 'trendingIndicator':
      // Source: Product.trendingAt within TRENDING_WINDOW_MS.
      // Boolean only — the raw timestamp NEVER reaches the wire.
      if (!source.trendingAt) return false;
      return now.getTime() - source.trendingAt.getTime() < TRENDING_WINDOW_MS;

    case 'purchaseCount':
    case 'soldCount':
    case 'stockCount':
    case 'ratingsCount':
    case 'popularityScore':
      // No source wired yet. Returning undefined keeps the key
      // OFF the wire even though the merchant flipped it on —
      // the dashboard remains usable (no error) but the chip
      // simply doesn't render. When a source lands, this case
      // gets a value and the chip starts rendering with zero
      // frontend changes.
      return undefined;

    default: {
      // Exhaustiveness guard. If a new key is added to
      // METRICS_VISIBILITY_KEYS without a case here, TypeScript
      // refuses to compile — catches the architectural gap at
      // build time, not in production.
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

// Defense: a negative denormalized counter would be a bug
// upstream, but we don't want to leak that bug to the storefront
// as a "-2 wishlisted" chip. Clamp to >= 0 and return undefined
// if the source is missing (so the chip doesn't render at all
// rather than rendering "0").
function clampNonNegative(
  value: number | null | undefined,
): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  return Math.floor(value);
}
