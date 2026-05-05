-- Add Order.productId / Order.storeId so the catalog identifiers survive
-- the trip from order creation to payment confirmation, where the Gift
-- gets minted. Both columns are optional — sample-product orders leave
-- them null, just like Gift.productId / Gift.storeId.
ALTER TABLE "Order" ADD COLUMN "productId" TEXT;
ALTER TABLE "Order" ADD COLUMN "storeId"   TEXT;
