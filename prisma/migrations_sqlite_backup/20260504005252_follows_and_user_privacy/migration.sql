-- CreateTable
CREATE TABLE "Follow" (
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,

    PRIMARY KEY ("followerId", "followingId"),
    CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Gift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "storeId" TEXT,
    "productId" TEXT,
    "messageText" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_address',
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "addressId" TEXT,
    "confirmedAt" DATETIME,
    "shippedAt" DATETIME,
    "deliveredAt" DATETIME,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Gift_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Gift_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Gift_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Gift_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Gift_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Gift" ("addressId", "carrier", "confirmedAt", "createdAt", "deliveredAt", "id", "isAnonymous", "mediaType", "mediaUrl", "messageText", "productId", "productName", "receiverId", "senderId", "shippedAt", "status", "storeId", "storeName", "trackingNumber") SELECT "addressId", "carrier", "confirmedAt", "createdAt", "deliveredAt", "id", "isAnonymous", "mediaType", "mediaUrl", "messageText", "productId", "productName", "receiverId", "senderId", "shippedAt", "status", "storeId", "storeName", "trackingNumber" FROM "Gift";
DROP TABLE "Gift";
ALTER TABLE "new_Gift" RENAME TO "Gift";
CREATE INDEX "Gift_senderId_idx" ON "Gift"("senderId");
CREATE INDEX "Gift_receiverId_idx" ON "Gift"("receiverId");
CREATE INDEX "Gift_storeId_status_idx" ON "Gift"("storeId", "status");
CREATE INDEX "Gift_status_createdAt_idx" ON "Gift"("status", "createdAt");
CREATE TABLE "new_Otp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "target" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Otp" ("code", "createdAt", "expiresAt", "id", "target", "type") SELECT "code", "createdAt", "expiresAt", "id", "target", "type" FROM "Otp";
DROP TABLE "Otp";
ALTER TABLE "new_Otp" RENAME TO "Otp";
CREATE INDEX "Otp_target_idx" ON "Otp"("target");
CREATE INDEX "Otp_target_type_createdAt_idx" ON "Otp"("target", "type", "createdAt");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fullName" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "qiftUsername" TEXT NOT NULL,
    "passwordHash" TEXT,
    "defaultAddress" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "bio" TEXT,
    "avatarUrl" TEXT,
    "profileVisibility" TEXT NOT NULL DEFAULT 'public',
    "showGiftsReceived" BOOLEAN NOT NULL DEFAULT true,
    "showGiftsSent" BOOLEAN NOT NULL DEFAULT true,
    "showFollowers" BOOLEAN NOT NULL DEFAULT true,
    "showFollowing" BOOLEAN NOT NULL DEFAULT true,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
);
INSERT INTO "new_User" ("createdAt", "defaultAddress", "email", "fullName", "id", "passwordHash", "phone", "qiftUsername", "role") SELECT "createdAt", "defaultAddress", "email", "fullName", "id", "passwordHash", "phone", "qiftUsername", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_qiftUsername_key" ON "User"("qiftUsername");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Follow_followingId_createdAt_idx" ON "Follow"("followingId", "createdAt");

-- CreateIndex
CREATE INDEX "Follow_followerId_createdAt_idx" ON "Follow"("followerId", "createdAt");

