-- Shipment + ShipmentEvent tables for richer courier tracking.
--
-- Backwards-compatible: pre-shipment gifts continue to use the
-- existing Gift.trackingNumber / Gift.carrier columns (those are
-- still written by markShipped for clients that don't create a
-- Shipment row). New code creates a Shipment per Gift; the
-- (giftId) unique constraint makes re-shipping idempotent.
--
-- PRIVACY: events carry a free-text status note from the
-- merchant — no receiver address detail.

CREATE TABLE "Shipment" (
  "id"             TEXT         NOT NULL,
  "giftId"         TEXT         NOT NULL,
  "provider"       TEXT         NOT NULL,
  "trackingNumber" TEXT,
  "trackingUrl"    TEXT,
  "status"         TEXT         NOT NULL DEFAULT 'registered',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Shipment_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "Shipment_giftId_fkey" FOREIGN KEY ("giftId")
    REFERENCES "Gift"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Shipment_giftId_key" ON "Shipment"("giftId");

CREATE TABLE "ShipmentEvent" (
  "id"         TEXT         NOT NULL,
  "shipmentId" TEXT         NOT NULL,
  "status"     TEXT         NOT NULL,
  "note"       TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ShipmentEvent_pkey"            PRIMARY KEY ("id"),
  CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId")
    REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ShipmentEvent_shipmentId_occurredAt_idx"
  ON "ShipmentEvent"("shipmentId", "occurredAt");
