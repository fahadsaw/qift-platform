-- Verification architecture columns.
--
-- User: phone is OTP-verified at /auth/register, so existing rows are
-- treated as already verified — backfill phoneVerifiedAt to createdAt
-- so every existing account looks "Verified" on the social-accounts UI
-- without forcing a re-verification round-trip. Email has no
-- verification flow yet, so emailVerifiedAt stays null on existing rows.
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
UPDATE "User" SET "phoneVerifiedAt" = "createdAt" WHERE "phoneVerifiedAt" IS NULL;

-- SocialAccount: tri-state verification level.
-- Existing rows with verified=true are level='verified' (manual claims
-- never set verified=true today; this branch lets us upgrade rows the
-- moment a future trust path stamps the legacy boolean).
-- Everyone else lands at the new default 'unverified'.
ALTER TABLE "SocialAccount" ADD COLUMN "verificationLevel" TEXT NOT NULL DEFAULT 'unverified';
UPDATE "SocialAccount" SET "verificationLevel" = 'verified' WHERE "verified" = true;
