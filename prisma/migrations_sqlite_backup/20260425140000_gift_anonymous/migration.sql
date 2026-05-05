-- Add anonymous-sender flag to Gift. SQLite stores booleans as integers
-- (0/1); the existing rows get the default 0 (not anonymous).
ALTER TABLE "Gift" ADD COLUMN "isAnonymous" BOOLEAN NOT NULL DEFAULT false;
