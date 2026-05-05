-- Address v2 columns are already present from the partial first run; the
-- Gift addressId + status remap was split out into a follow-up migration
-- (20260425170100_gift_address_v2). This file is intentionally left empty
-- so `prisma migrate deploy` records it without re-running the column adds.
SELECT 1;
