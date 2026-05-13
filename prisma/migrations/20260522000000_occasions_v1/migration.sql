-- Phase 6.1 — Occasions foundation.
--
-- See project_occasions_architecture.md (user memory) for the full
-- design rationale. This migration ships the data layer ONLY:
--
--   • Occasion         — birthdays / anniversaries / cultural /
--                        milestone rows. Calendar-aware
--                        (Gregorian + Hijri) via (calendar,
--                        year?, month, day) triple, NOT DateTime.
--   • OccasionReminder — per-user cadence rows. Reminder FIRING
--                        is gated to Phase 7; this table just
--                        holds the data so Phase 7 has a populated
--                        layer to switch on.
--   • Gift.occasionId  — optional sender-side tag linking a gift
--                        to the occasion it acknowledges.
--
-- Indexes match the architecture doc Section 11 (scalability).

-- Sender-side optional tag. SetNull on Occasion delete so a gift's
-- history isn't broken when the occasion row is later cleaned up.
ALTER TABLE "Gift" ADD COLUMN "occasionId" TEXT;

CREATE TABLE "Occasion" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT,
  "kind"          TEXT NOT NULL,
  "label"         TEXT,
  "calendar"      TEXT NOT NULL,
  "year"          INTEGER,
  "month"         INTEGER NOT NULL,
  "day"           INTEGER NOT NULL,
  "recurrence"    TEXT NOT NULL,
  "visibility"    TEXT NOT NULL DEFAULT 'private',
  "regionCode"    TEXT,
  "relatedUserId" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  "deactivatedAt" TIMESTAMP(3),

  CONSTRAINT "Occasion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OccasionReminder" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "occasionId"  TEXT NOT NULL,
  "daysBefore"  INTEGER NOT NULL,
  "channel"     TEXT NOT NULL DEFAULT 'digest',
  "enabled"     BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "OccasionReminder_pkey" PRIMARY KEY ("id")
);

-- Indexes (per architecture doc Section 11)
CREATE INDEX "Occasion_userId_deactivatedAt_idx"
  ON "Occasion"("userId", "deactivatedAt");
CREATE INDEX "Occasion_relatedUserId_deactivatedAt_idx"
  ON "Occasion"("relatedUserId", "deactivatedAt");
-- Hot path: the future reminder sweep finds every occasion firing
-- today by (calendar, month, day) without per-user scans.
CREATE INDEX "Occasion_calendar_month_day_deactivatedAt_idx"
  ON "Occasion"("calendar", "month", "day", "deactivatedAt");

-- Reminder uniqueness — one row per (user, occasion, daysBefore).
CREATE UNIQUE INDEX "OccasionReminder_userId_occasionId_daysBefore_key"
  ON "OccasionReminder"("userId", "occasionId", "daysBefore");
CREATE INDEX "OccasionReminder_userId_enabled_idx"
  ON "OccasionReminder"("userId", "enabled");

-- Foreign keys
ALTER TABLE "Gift"
  ADD CONSTRAINT "Gift_occasionId_fkey"
  FOREIGN KEY ("occasionId") REFERENCES "Occasion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Occasion"
  ADD CONSTRAINT "Occasion_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Occasion"
  ADD CONSTRAINT "Occasion_relatedUserId_fkey"
  FOREIGN KEY ("relatedUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OccasionReminder"
  ADD CONSTRAINT "OccasionReminder_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OccasionReminder"
  ADD CONSTRAINT "OccasionReminder_occasionId_fkey"
  FOREIGN KEY ("occasionId") REFERENCES "Occasion"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
