// Storefront theme registry — server-side allow-list + config
// validators. The DB `StoreTheme` table carries display metadata
// for the dashboard picker; this file carries the authoritative
// allow-list of theme slugs and the per-theme capability +
// config validation rules that the service enforces.
//
// Why a code-level allow-list (and not just a DB lookup)?
//   1. Plan gating is a code concern (merchant-plans.ts), not a
//      data concern. We map slug → required capability here.
//   2. Per-theme config validation is type-aware code. Each new
//      theme adds its own validator function in this file.
//   3. Adding a new theme touches three places — DB seed row,
//      frontend `themes.ts` manifest, AND this registry. That
//      cross-reference is the architectural discipline that
//      keeps presentation, validation, and gating from drifting.
//
// See `project_storefront_architecture.md` Section 3 + 5.

import type { MerchantCapability } from './merchant-plans';
import { planHas } from './merchant-plans';

// Canonical theme slugs. Stable string union; adding a new theme
// is a one-line change here + a new validator below + a new
// component file on the frontend + a new StoreTheme seed row.
export const STOREFRONT_THEME_SLUGS = [
  'classic',
  'gallery',
  'editorial',
] as const;
export type StorefrontThemeSlug = (typeof STOREFRONT_THEME_SLUGS)[number];

export function isStorefrontThemeSlug(
  value: string,
): value is StorefrontThemeSlug {
  return (STOREFRONT_THEME_SLUGS as readonly string[]).includes(value);
}

// Slug → required merchant capability. The dispatcher consults
// this on EVERY storefront render so a plan downgrade falls back
// to the default (classic) without losing the stored themeSlug.
const THEME_CAPABILITY: Record<StorefrontThemeSlug, MerchantCapability | null> =
  {
    // Classic is available on every plan — no capability gate.
    classic: null,
    // Gallery requires the 'theme_gallery' capability (Pro+).
    gallery: 'theme_gallery',
    // Editorial requires the 'theme_editorial' capability (Enterprise).
    editorial: 'theme_editorial',
  };

export function isThemeEligible(
  plan: string,
  slug: StorefrontThemeSlug,
): boolean {
  const capability = THEME_CAPABILITY[slug];
  if (capability === null) return true; // free for everyone
  return planHas(plan, capability);
}

// Resolve the rendering-time theme for a store. Reads the stored
// slug but falls back to 'classic' when the plan no longer covers
// it (downgrade-safe). The stored value is NEVER mutated by this
// helper — re-upgrade restores instantly.
export function resolveActiveTheme(
  storedSlug: string,
  plan: string,
): StorefrontThemeSlug {
  if (!isStorefrontThemeSlug(storedSlug)) return 'classic';
  if (!isThemeEligible(plan, storedSlug)) return 'classic';
  return storedSlug;
}

// ── themeConfig validation ────────────────────────────────────
//
// Bounded allow-list per `project_storefront_architecture.md`
// Section 2.4 + 3.2. We don't accept free-form JSON — every
// recognized key is validated; unknown keys are silently dropped.
//
// Universal keys (all themes support): accentColor, bannerImageUrl,
// heroHeadline, heroSubhead.
//
// Per-theme config nests under `themeSpecific.<slug>.*` — each
// theme declares its own subset. V1 themes ship with NO theme-
// specific config; the slot is reserved for future use.

export type StoreThemeConfig = {
  accentColor?: string;
  bannerImageUrl?: string;
  heroHeadline?: string;
  heroSubhead?: string;
  themeSpecific?: Record<string, unknown>;
};

// Curated accent palette. Free-form hex is a tempting open door
// but it's also a brand-coherence + accessibility risk. V1 ships
// with a curated set; adding more is a one-line change.
const ACCENT_PALETTE = new Set<string>([
  '#7B5CF5', // primary (default)
  '#5A8AC8', // blue
  '#6FA882', // green
  '#D64A55', // red
  '#E89AAE', // pink
  '#D4A85A', // gold
  '#C5C5CC', // silver
  '#1A1A1F', // ink
]);

const HEADLINE_MAX = 80;
const SUBHEAD_MAX = 160;
// Allow http(s) URLs only; the storefront only renders the value
// inside an <img src> — it cannot be a javascript: URL.
const HTTPS_URL = /^https?:\/\/[^\s<>"']{1,512}$/;

// Validate + sanitize a candidate config. Returns the sanitized
// object (only recognized + valid keys). Unknown keys silently
// dropped — forward-compat for adding new fields without
// rejecting older payloads.
//
// Per-theme nested config (`themeSpecific.<slug>.*`) is passed
// through as-is for V1 — V1 themes ship with no theme-specific
// config. When a future theme adds its own keys, it registers a
// nested validator here.
export function sanitizeThemeConfig(input: unknown): StoreThemeConfig | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const out: StoreThemeConfig = {};

  if (typeof obj.accentColor === 'string') {
    const v = obj.accentColor.trim().toUpperCase();
    if (ACCENT_PALETTE.has(v)) {
      out.accentColor = v;
    }
  }
  if (typeof obj.bannerImageUrl === 'string') {
    const v = obj.bannerImageUrl.trim();
    if (HTTPS_URL.test(v)) out.bannerImageUrl = v;
  }
  if (typeof obj.heroHeadline === 'string') {
    const v = obj.heroHeadline.trim();
    if (v.length > 0 && v.length <= HEADLINE_MAX) out.heroHeadline = v;
  }
  if (typeof obj.heroSubhead === 'string') {
    const v = obj.heroSubhead.trim();
    if (v.length > 0 && v.length <= SUBHEAD_MAX) out.heroSubhead = v;
  }
  if (typeof obj.themeSpecific === 'object' && obj.themeSpecific !== null) {
    // Pass-through for V1. When themes register per-theme
    // validators, this becomes a per-slug dispatch instead.
    out.themeSpecific = obj.themeSpecific as Record<string, unknown>;
  }
  return Object.keys(out).length === 0 ? null : out;
}

// ── metricsVisibility validation ──────────────────────────────
//
// Per-metric publicity flags. Same shape as the User-side
// preferencesVisibility (Phase 2). Per-field opt-in basis —
// every key defaults to false (owner-only). Unknown keys
// silently dropped; values coerced to strict boolean.

export const METRICS_VISIBILITY_KEYS = [
  'wishlistSaves',
  'purchaseCount',
  'giftedCount',
  'popularityScore',
  'ratingsCount',
  'stockCount',
  'soldCount',
  'trendingIndicator',
] as const;
export type MetricsVisibilityKey = (typeof METRICS_VISIBILITY_KEYS)[number];

export type StoreMetricsVisibility = Partial<
  Record<MetricsVisibilityKey, boolean>
>;

export function sanitizeMetricsVisibility(
  input: unknown,
): StoreMetricsVisibility | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const out: StoreMetricsVisibility = {};
  for (const k of METRICS_VISIBILITY_KEYS) {
    if (k in obj) {
      out[k] = obj[k] === true;
    }
  }
  // Return null when nothing was set so the DB column stays NULL
  // (treated as all-private by the projection helpers).
  return Object.keys(out).length === 0 ? null : out;
}

// Read the flags dict tolerantly. Used by the public-storefront
// projection to decide which metric fields to ship to the frontend.
// Defensive: malformed JSON in the DB returns null → all-private.
export function readMetricsVisibility(
  raw: unknown,
): Record<MetricsVisibilityKey, boolean> {
  const out = {} as Record<MetricsVisibilityKey, boolean>;
  const obj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  for (const k of METRICS_VISIBILITY_KEYS) {
    out[k] = obj[k] === true;
  }
  return out;
}
