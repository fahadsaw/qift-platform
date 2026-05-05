-- Gift v2: link a chosen Address (set when the receiver confirms) and
-- migrate the legacy status enum onto the new pipeline.
--   pending  -> pending_address     (waiting for receiver to confirm)
--   accepted -> ready_for_delivery  (receiver has confirmed)
--   rejected -> pending_address     (re-confirm required; rejected is gone)

ALTER TABLE "Gift" ADD COLUMN "addressId" TEXT
  REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "Gift" SET "status" = 'pending_address'    WHERE "status" = 'pending';
UPDATE "Gift" SET "status" = 'ready_for_delivery' WHERE "status" = 'accepted';
UPDATE "Gift" SET "status" = 'pending_address'    WHERE "status" = 'rejected';
