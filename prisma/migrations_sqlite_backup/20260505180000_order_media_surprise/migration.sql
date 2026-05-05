-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "giftId" TEXT,
    "receiverUsername" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "productId" TEXT,
    "storeId" TEXT,
    "productPrice" REAL NOT NULL,
    "serviceFee" REAL NOT NULL,
    "deliveryFee" REAL NOT NULL,
    "totalAmount" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "paymentProvider" TEXT NOT NULL,
    "message" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "isSurprise" BOOLEAN NOT NULL DEFAULT false,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Order_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "Gift" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("country", "createdAt", "currency", "deliveryFee", "giftId", "id", "isAnonymous", "message", "paymentProvider", "productId", "productName", "productPrice", "receiverUsername", "serviceFee", "status", "storeId", "storeName", "totalAmount", "userId") SELECT "country", "createdAt", "currency", "deliveryFee", "giftId", "id", "isAnonymous", "message", "paymentProvider", "productId", "productName", "productPrice", "receiverUsername", "serviceFee", "status", "storeId", "storeName", "totalAmount", "userId" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_giftId_key" ON "Order"("giftId");
CREATE INDEX "Order_userId_idx" ON "Order"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

