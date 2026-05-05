-- Stores + Products + integration scaffolding.
--   1. Add User.role to discriminate store accounts.
--   2. Create Store + Product tables.
--   3. Add Gift.storeId / Gift.productId so the per-store dashboard
--      can filter by ownership and stock checks can resolve a product.

ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';

CREATE TABLE "Store" (
    "id"                TEXT PRIMARY KEY NOT NULL,
    "name"              TEXT NOT NULL,
    "ownerId"           TEXT NOT NULL,
    "city"              TEXT NOT NULL,
    "category"          TEXT NOT NULL,
    "integrationType"   TEXT NOT NULL DEFAULT 'none',
    "integrationStatus" TEXT NOT NULL DEFAULT 'disconnected',
    "webhookSecret"     TEXT,
    "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Store_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Store_ownerId_idx" ON "Store"("ownerId");

CREATE TABLE "Product" (
    "id"                TEXT PRIMARY KEY NOT NULL,
    "storeId"           TEXT NOT NULL,
    "name"              TEXT NOT NULL,
    "price"             REAL NOT NULL,
    "imageUrl"          TEXT,
    "category"          TEXT NOT NULL,
    "isFastDelivery"    BOOLEAN NOT NULL DEFAULT false,
    "sourceType"        TEXT NOT NULL DEFAULT 'manual',
    "externalProductId" TEXT,
    "stockStatus"       TEXT NOT NULL DEFAULT 'in_stock',
    "isAvailable"       BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt"      DATETIME,
    "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Product_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "Store"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Product_storeId_idx" ON "Product"("storeId");
CREATE UNIQUE INDEX "Product_storeId_externalProductId_key"
  ON "Product"("storeId", "externalProductId");

ALTER TABLE "Gift" ADD COLUMN "storeId"   TEXT
  REFERENCES "Store"("id") ON DELETE SET NULL;
ALTER TABLE "Gift" ADD COLUMN "productId" TEXT
  REFERENCES "Product"("id") ON DELETE SET NULL;
CREATE INDEX "Gift_storeId_status_idx" ON "Gift"("storeId", "status");
