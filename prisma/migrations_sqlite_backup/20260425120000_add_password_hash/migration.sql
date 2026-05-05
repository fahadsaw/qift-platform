-- Add nullable passwordHash column to User. Existing rows remain NULL until
-- the user resets their password (see auth service: legacy users get a clear
-- error pointing them to reset).
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
