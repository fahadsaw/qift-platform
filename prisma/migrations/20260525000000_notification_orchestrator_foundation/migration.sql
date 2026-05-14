-- Phase 7.1 — notification orchestrator foundation.
--
-- Data-layer changes to support category-aware notification
-- delivery, per-user opt-outs, quiet hours, and the future digest
-- worker. NO reminder firing is activated by this migration —
-- only the scaffolding the orchestrator + worker will read.

-- ── Notification: category + priority + push-delivery telemetry ──
--
-- All three columns are nullable so existing rows (written before
-- Phase 7.1) stay valid. Orchestrator writes fill them; the few
-- legacy rows in the wild render fine with null category (the
-- frontend doesn't depend on these fields yet).
ALTER TABLE "Notification" ADD COLUMN "category" TEXT;
ALTER TABLE "Notification" ADD COLUMN "priority" TEXT;
ALTER TABLE "Notification" ADD COLUMN "pushDeliveredAt" TIMESTAMP(3);

-- Budget engine read path. Counts rows per (user, category) within
-- a sliding window — this composite index makes the count cheap
-- even on a hot bell.
CREATE INDEX "Notification_userId_category_createdAt_idx"
  ON "Notification"("userId", "category", "createdAt");

-- Future-digest worker read path. Scans rows that haven't been
-- pushed yet (alert channels deferred). Sparse-ish — most rows
-- have pushDeliveredAt set after they fire.
CREATE INDEX "Notification_userId_pushDeliveredAt_idx"
  ON "Notification"("userId", "pushDeliveredAt");

-- ── NotificationPreferences (new) ────────────────────────────────
--
-- One row per user, lazily created on first read. Defaults are
-- safe — a missing row is equivalent to "no overrides":
--   - No quiet hours configured
--   - All categories opted in
--   - Digest enabled (daily)
--
-- userId is BOTH the primary key AND the foreign key. The 1:1
-- relationship with User is enforced by this constraint.
CREATE TABLE "NotificationPreferences" (
  "userId"             TEXT NOT NULL,
  "quietHoursStart"    TEXT,
  "quietHoursEnd"      TEXT,
  "quietHoursTimezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  "categoryOptOuts"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "digestEnabled"      BOOLEAN NOT NULL DEFAULT TRUE,
  "digestFrequency"    TEXT NOT NULL DEFAULT 'daily',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NotificationPreferences_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "NotificationPreferences"
  ADD CONSTRAINT "NotificationPreferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
