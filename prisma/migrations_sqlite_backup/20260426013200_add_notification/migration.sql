-- In-app notifications. The (userId, isRead) index serves the unread-badge
-- count; (userId, createdAt) serves the latest-first list query.
CREATE TABLE "Notification" (
    "id"        TEXT PRIMARY KEY NOT NULL,
    "userId"    TEXT NOT NULL,
    "type"      TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "body"      TEXT,
    "link"      TEXT,
    "isRead"    BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Notification_userId_isRead_idx"    ON "Notification"("userId", "isRead");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
