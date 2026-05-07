-- Per-user opt-out for phone-number discovery.
--
-- Phone is the most privacy-sensitive contact channel a user can
-- expose to search. The previous behaviour was "if you have a phone
-- on file, anyone with the number can find you" — too permissive.
-- This column lets a user keep their account public for username /
-- social search while opting out of phone-by-phone-number lookups.
--
-- Defaults to true so existing demo accounts keep their current
-- discoverability without a forced re-onboarding. Operators who want
-- a privacy-first default can flip the column-level default to false
-- in a follow-up migration once the UI toggle is shipped.
ALTER TABLE "User"
ADD COLUMN "allowPhoneDiscovery" BOOLEAN NOT NULL DEFAULT true;
