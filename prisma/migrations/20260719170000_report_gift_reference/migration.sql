-- Track A.5 PR 9: disputes/reports can reference the gift they are
-- about (plain column, no FK — reports survive gift purges the same
-- way the corporate money tables survive org purges). Additive only;
-- production Report rows: ZERO (verified read-only 2026-07-19).

ALTER TABLE "Report" ADD COLUMN "giftId" TEXT;

CREATE INDEX "Report_giftId_idx" ON "Report"("giftId");
