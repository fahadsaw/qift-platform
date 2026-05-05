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
    "isSurprise" BOOLEAN NOT NULL DEFAULT false,
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
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

