-- Storefront themes V1 — Phase 5 of the staged roadmap.
--
-- Three coupled changes that land together as the foundation for
-- the layered presentation system (see
-- `project_storefront_architecture.md`):
--
-- 1) `StoreTheme` registry — metadata + plan gating for available
--    themes. V1 seed rows: classic / gallery / editorial.
--
-- 2) `Store.themeSlug` + `Store.themeConfig` — currently selected
--    theme per store + bounded per-store branding overrides.
--    Backfill: every existing store gets themeSlug='classic'
--    (preserves current visuals exactly via the default), and
--    themeConfig stays NULL (no overrides).
--
-- 3) `Store.metricsVisibility` — JSON dict of per-metric publicity
--    flags. Default NULL = all hidden (treated as every flag
--    false). Per-field opt-in. Storefront primitives consume the
--    sanitized projection so themes never see hidden values.
--
-- Plan gating is enforced server-side by StoreService — the
-- dispatcher reads live plan capability via the existing
-- capabilitiesFor() helper. A plan downgrade falls back to
-- 'classic' automatically at render time without losing the
-- stored themeSlug (re-upgrade restores instantly).

-- ── Step 1: StoreTheme registry ─────────────────────────────
CREATE TABLE "StoreTheme" (
  "slug"            TEXT         NOT NULL,
  "name"            TEXT         NOT NULL,
  "minPlan"         TEXT         NOT NULL,
  "previewUrl"      TEXT         NOT NULL,
  "descriptionKey"  TEXT,
  "isActive"        BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StoreTheme_pkey" PRIMARY KEY ("slug")
);

-- ── Step 2: seed V1 themes ──────────────────────────────────
-- Three themes for V1 — see project_storefront_architecture Section 6.
-- The previewUrl values are R2-hosted static thumbnails (PNG/WebP);
-- placeholders here, real assets uploaded with the dashboard picker
-- commit. The display names are the canonical English fallback;
-- the dashboard renders localized names via translation keys
-- `themes.<slug>.name` and falls back to this column when the
-- locale dict has no entry.
INSERT INTO "StoreTheme" ("slug", "name", "minPlan", "previewUrl", "descriptionKey", "isActive") VALUES
  ('classic',   'Classic',   'starter',    'https://r2.qift.app/themes/classic.webp',   'themes.classic.description',   true),
  ('gallery',   'Gallery',   'pro',        'https://r2.qift.app/themes/gallery.webp',   'themes.gallery.description',   true),
  ('editorial', 'Editorial', 'enterprise', 'https://r2.qift.app/themes/editorial.webp', 'themes.editorial.description', true);

-- ── Step 3: Store.themeSlug ─────────────────────────────────
-- Default 'classic' — every existing store keeps its current
-- visual identity. No backfill query needed; the column default
-- handles new + existing rows.
ALTER TABLE "Store"
  ADD COLUMN "themeSlug" TEXT NOT NULL DEFAULT 'classic';

-- ── Step 4: Store.themeConfig ───────────────────────────────
-- Bounded per-store overrides. JSON for forward-compat — adding
-- a new recognized key doesn't need a schema migration. NULL =
-- no overrides; theme uses built-in defaults.
ALTER TABLE "Store"
  ADD COLUMN "themeConfig" JSONB;

-- ── Step 5: Store.metricsVisibility ─────────────────────────
-- Per-metric publicity flags. JSON dict — same pattern as
-- User.preferencesVisibility. NULL = all hidden (opt-in basis).
ALTER TABLE "Store"
  ADD COLUMN "metricsVisibility" JSONB;
