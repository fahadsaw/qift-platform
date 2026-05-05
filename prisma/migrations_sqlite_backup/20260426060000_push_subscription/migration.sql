-- Web Push subscription rows. One per user-device pair, keyed by the
-- push service `endpoint`. The unique index lets us upsert by endpoint
-- so repeat `subscribe` calls from the same browser reuse the same row.
CREATE TABLE "PushSubscription" (
    "id"        TEXT PRIMARY KEY NOT NULL,
    "userId"    TEXT NOT NULL,
    "endpoint"  TEXT NOT NULL,
    "p256dh"    TEXT NOT NULL,
    "auth"      TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PushSubscription_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx"           ON "PushSubscription"("userId");
