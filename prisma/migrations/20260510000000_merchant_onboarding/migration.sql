-- Merchant onboarding v2 — extend Store with business / legal /
-- branding / coverage fields, add review-trail columns, and add a
-- StoreDocument table for uploaded verification docs.
--
-- Backwards-compatible: every new Store column is NULLABLE so
-- existing rows survive without a backfill. The status string
-- union is widened (additive) — pre-v2 rows keep their existing
-- 'pending' / 'approved' / 'rejected' / 'suspended' values.

-- ── Business / legal identity ────────────────────────────────
ALTER TABLE "Store" ADD COLUMN "legalEntityName"              TEXT;
ALTER TABLE "Store" ADD COLUMN "countryOfRegistration"        TEXT;
ALTER TABLE "Store" ADD COLUMN "commercialRegistrationNumber" TEXT;
ALTER TABLE "Store" ADD COLUMN "vatNumber"                    TEXT;

-- ── Contact PoC ─────────────────────────────────────────────
ALTER TABLE "Store" ADD COLUMN "contactPerson" TEXT;
ALTER TABLE "Store" ADD COLUMN "contactPhone"  TEXT;
ALTER TABLE "Store" ADD COLUMN "contactEmail"  TEXT;

-- ── Branding & social ───────────────────────────────────────
ALTER TABLE "Store" ADD COLUMN "logoUrl"         TEXT;
ALTER TABLE "Store" ADD COLUMN "coverImageUrl"   TEXT;
ALTER TABLE "Store" ADD COLUMN "websiteUrl"      TEXT;
ALTER TABLE "Store" ADD COLUMN "instagramHandle" TEXT;
ALTER TABLE "Store" ADD COLUMN "tiktokHandle"    TEXT;
ALTER TABLE "Store" ADD COLUMN "snapchatHandle"  TEXT;

-- ── Delivery coverage ────────────────────────────────────────
-- JSONB array of { city, districts?, note? } entries. Null /
-- empty array → fall back to the legacy single `city` column.
ALTER TABLE "Store" ADD COLUMN "deliveryZones" JSONB;

-- ── Approval review trail ────────────────────────────────────
ALTER TABLE "Store" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "Store" ADD COLUMN "submittedAt"     TIMESTAMP(3);
ALTER TABLE "Store" ADD COLUMN "reviewedAt"      TIMESTAMP(3);
-- FK column to User.id of the admin who reviewed. Not enforced
-- with a hard FK to avoid blocking admin-account deletes; audit
-- trail only.
ALTER TABLE "Store" ADD COLUMN "reviewedBy"      TEXT;

-- ── Per-store onboarding documents ──────────────────────────
CREATE TABLE "StoreDocument" (
  "id"          TEXT NOT NULL,
  "storeId"     TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "fileUrl"     TEXT NOT NULL,
  "fileName"    TEXT,
  "contentType" TEXT,
  "uploadedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StoreDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StoreDocument_storeId_idx" ON "StoreDocument"("storeId");

ALTER TABLE "StoreDocument"
  ADD CONSTRAINT "StoreDocument_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
