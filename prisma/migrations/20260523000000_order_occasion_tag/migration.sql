-- Phase 6.4 — Order.occasionId tag.
--
-- Threads the optional occasion attach the sender chose on /send
-- through Order so PaymentsService can forward it to Gift.create
-- when the payment confirms. Mirrors Gift.occasionId (added in
-- Phase 6.1) — same SetNull semantics so a soft-deleted Occasion
-- doesn't block paid orders from progressing.
--
-- No FK constraint on Order.occasionId for V1: payment confirmation
-- already double-checks at Gift.create time, and adding an FK here
-- would require an Occasion lookup on every Order write. Phase 7
-- can promote to a constrained FK once we have telemetry on actual
-- attach rates.

ALTER TABLE "Order" ADD COLUMN "occasionId" TEXT;
