-- One-time-password store. Codes live for 5 minutes (enforced in service);
-- multiple codes per target are allowed and we always verify against the
-- newest one. A scheduled cleanup job can later prune rows where
-- expiresAt < now() - 1 day.
CREATE TABLE "Otp" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "target" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Otp_target_idx" ON "Otp"("target");
