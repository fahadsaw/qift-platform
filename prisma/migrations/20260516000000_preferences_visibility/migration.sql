-- Per-field publicity flags for the User preferences set.
--
-- Stored as JSONB so adding a new preference field doesn't need
-- another schema migration — the flag dict grows in place. The
-- public-profile projection reads this column and includes only the
-- opted-in preference fields in its response.
--
-- Recognized keys (each maps to a boolean):
--   clothingSize | shoeSize | ringSize | fragrance |
--   colors | categories | brands | allergies | surprises
--
-- Default NULL = every preference is owner-only. Per-field privacy is
-- opt-in: each flag flips to true only when the owner explicitly
-- shares that field on /preferences.

ALTER TABLE "User"
  ADD COLUMN "preferencesVisibility" JSONB;
