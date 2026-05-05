-- CreateTable
CREATE TABLE "GiftAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "receiverUsername" TEXT NOT NULL,
    "productName" TEXT,
    "storeName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" DATETIME,
    "resolvedAt" DATETIME,
    CONSTRAINT "GiftAttempt_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GiftAttempt_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GiftAttempt_receiverId_resolvedAt_idx" ON "GiftAttempt"("receiverId", "resolvedAt");

-- CreateIndex
CREATE INDEX "GiftAttempt_senderId_idx" ON "GiftAttempt"("senderId");
