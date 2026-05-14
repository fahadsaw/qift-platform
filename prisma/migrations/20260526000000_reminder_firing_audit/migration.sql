-- Phase 7.2 — ReminderFiring audit table.
--
-- Append-only log of every occasion-reminder firing attempt.
-- The unique constraint on (reminderId, occurrenceAt) is the
-- load-bearing idempotency guarantee: re-running the worker for
-- the same (reminder, occurrence) is a no-op.
--
-- This migration ships the AUDIT layer only. The worker that
-- writes rows here is gated behind QIFT_OCCASION_REMINDER_FIRING_
-- ENABLED (default false); no rows are produced until the flag
-- is flipped + the admin endpoint is invoked.

CREATE TABLE "ReminderFiring" (
  "id"           TEXT NOT NULL,
  "reminderId"   TEXT NOT NULL,
  -- UTC-midnight Date of the occasion's occurrence this firing
  -- covers. A yearly birthday produces one row per year.
  "occurrenceAt" TIMESTAMP(3) NOT NULL,
  "firedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 'claimed' | 'sent' | 'suppressed' | 'failed'
  "status"       TEXT NOT NULL DEFAULT 'claimed',
  -- Suppression / failure reason mirrored from
  -- NotificationOrchestrator.EnqueueResult. Null on 'claimed' /
  -- 'sent' rows.
  "reason"       TEXT,

  CONSTRAINT "ReminderFiring_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ReminderFiring"
  ADD CONSTRAINT "ReminderFiring_reminderId_fkey"
  FOREIGN KEY ("reminderId") REFERENCES "OccasionReminder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Idempotency anchor — two workers racing on the same
-- (reminder, occurrence) collide here; exactly one wins. Insert
-- before calling the orchestrator so a crash mid-call leaves a
-- 'claimed' row, not a duplicate firing.
CREATE UNIQUE INDEX "ReminderFiring_reminderId_occurrenceAt_key"
  ON "ReminderFiring"("reminderId", "occurrenceAt");

-- Operator + audit queries: "show me every firing for today" /
-- "list pending claims that never resolved" — both hit this
-- composite (status filters in 4 cardinalities; occurrenceAt
-- range scans).
CREATE INDEX "ReminderFiring_occurrenceAt_status_idx"
  ON "ReminderFiring"("occurrenceAt", "status");
