-- Phase 6.x — gender + free-text gift-note on the preferences surface.
--
-- Both fields are NULLABLE and have no defaults. The
-- preferencesVisibility allow-list gates whether they appear on the
-- public profile (default-private, per-field opt-in).
--
-- gender:    string hint for gift senders ('male' | 'female' | NULL).
--            No commerce path treats men/women differently — this is
--            purely a UI affordance for human gift-senders.
-- giftNote:  free-form note from the owner. Server caps writes at
--            280 chars; the public profile renders plain text only.
ALTER TABLE "User"
  ADD COLUMN "gender" TEXT,
  ADD COLUMN "giftNote" TEXT;
