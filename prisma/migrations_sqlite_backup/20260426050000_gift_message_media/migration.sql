-- Gift message v3:
--   1. Rename `message` to `messageText` so the API surface matches the
--      spec (text + image + video are sibling concepts).
--   2. Add `mediaUrl` + `mediaType` for image/video attachments.
--
-- The rename uses SQLite's native `ALTER TABLE RENAME COLUMN` (available
-- since 3.25.0, well below our target). Existing message data is
-- preserved by the rename — we never lose what buyers already wrote.

ALTER TABLE "Gift" RENAME COLUMN "message" TO "messageText";
ALTER TABLE "Gift" ADD COLUMN "mediaUrl"  TEXT;
ALTER TABLE "Gift" ADD COLUMN "mediaType" TEXT;
