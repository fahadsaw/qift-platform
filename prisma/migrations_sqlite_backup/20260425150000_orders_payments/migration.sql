-- Add Order + Payment tables. Order owns a nullable FK to Gift so the
-- gift is created only after the payment is confirmed.

CREATE TABLE "Order" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "giftId" TEXT,
  "receiverUsername" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "storeName" TEXT NOT NULL,
  "productPrice" REAL NOT NULL,
  "serviceFee" REAL NOT NULL,
  "deliveryFee" REAL NOT NULL,
  "totalAmount" REAL NOT NULL,
  "currency" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "paymentProvider" TEXT NOT NULL,
  "message" TEXT,
  "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Order_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "Gift" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Order_userId_idx" ON "Order"("userId");
CREATE UNIQUE INDEX "Order_giftId_key" ON "Order"("giftId");

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerPaymentId" TEXT,
  "amount" REAL NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");
