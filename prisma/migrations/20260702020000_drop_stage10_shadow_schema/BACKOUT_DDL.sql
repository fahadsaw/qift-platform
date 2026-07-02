-- BACKOUT REFERENCE — catalog-reconstructed DDL of the objects removed by
-- migration.sql. Reference only (the "..._not_null" ALTER lines are a PG16
-- catalog rendering; authoritative structure is the CREATE TABLE + FK + index
-- lines). All captured tables had 0 rows except RiskSignalEvent (1 row,
-- archived not dropped).

-- ============ GiftSession  (rows=0) ============
CREATE TABLE "GiftSession" (
  "id" text NOT NULL,
  "senderUserId" text NOT NULL,
  "status" text DEFAULT 'draft'::text NOT NULL,
  "totalGrossAmount" integer DEFAULT 0 NOT NULL,
  "totalFeesAmount" integer DEFAULT 0 NOT NULL,
  "totalNetSettleableAmount" integer DEFAULT 0 NOT NULL,
  "currencyCode" text DEFAULT 'SAR'::text NOT NULL,
  "metadata" jsonb,
  "draftedAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "checkedOutAt" timestamp without time zone,
  "paidAt" timestamp without time zone,
  "fulfilledAt" timestamp without time zone,
  "cancelledAt" timestamp without time zone,
  "refundedAt" timestamp without time zone
);
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_currencyCode_not_null" NOT NULL "currencyCode";
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_draftedAt_not_null" NOT NULL "draftedAt";
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_id_not_null" NOT NULL id;
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_pkey" PRIMARY KEY (id);
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_senderUserId_not_null" NOT NULL "senderUserId";
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_status_not_null" NOT NULL status;
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_totalFeesAmount_not_null" NOT NULL "totalFeesAmount";
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_totalGrossAmount_not_null" NOT NULL "totalGrossAmount";
ALTER TABLE "GiftSession" ADD CONSTRAINT "GiftSession_totalNetSettleableAmount_not_null" NOT NULL "totalNetSettleableAmount";
CREATE INDEX "GiftSession_senderUserId_status_idx" ON public."GiftSession" USING btree ("senderUserId", status);
CREATE INDEX "GiftSession_status_draftedAt_idx" ON public."GiftSession" USING btree (status, "draftedAt");

-- ============ GiftSessionRecipient  (rows=0) ============
CREATE TABLE "GiftSessionRecipient" (
  "id" text NOT NULL,
  "giftSessionId" text NOT NULL,
  "recipientUserId" text NOT NULL,
  "status" text DEFAULT 'pending_confirmation'::text NOT NULL,
  "messageText" text,
  "mediaUrl" text,
  "mediaType" text,
  "isSurprise" boolean DEFAULT false NOT NULL,
  "subtotalGrossAmount" integer DEFAULT 0 NOT NULL,
  "feesAllocatedAmount" integer DEFAULT 0 NOT NULL,
  "blockedMerchantOrders" integer DEFAULT 0 NOT NULL
);
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_blockedMerchantOrders_not_null" NOT NULL "blockedMerchantOrders";
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_feesAllocatedAmount_not_null" NOT NULL "feesAllocatedAmount";
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_giftSessionId_fkey" FOREIGN KEY ("giftSessionId") REFERENCES "GiftSession"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_giftSessionId_not_null" NOT NULL "giftSessionId";
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_id_not_null" NOT NULL id;
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_isSurprise_not_null" NOT NULL "isSurprise";
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_pkey" PRIMARY KEY (id);
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_recipientUserId_not_null" NOT NULL "recipientUserId";
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_status_not_null" NOT NULL status;
ALTER TABLE "GiftSessionRecipient" ADD CONSTRAINT "GiftSessionRecipient_subtotalGrossAmount_not_null" NOT NULL "subtotalGrossAmount";
CREATE UNIQUE INDEX "GiftSessionRecipient_giftSessionId_recipientUserId_key" ON public."GiftSessionRecipient" USING btree ("giftSessionId", "recipientUserId");
CREATE INDEX "GiftSessionRecipient_recipientUserId_status_idx" ON public."GiftSessionRecipient" USING btree ("recipientUserId", status);

-- ============ MerchantOrder  (rows=0) ============
CREATE TABLE "MerchantOrder" (
  "id" text NOT NULL,
  "giftSessionId" text NOT NULL,
  "giftSessionRecipientId" text NOT NULL,
  "recipientUserId" text NOT NULL,
  "storeId" text NOT NULL,
  "status" text DEFAULT 'pending_recipient'::text NOT NULL,
  "shippingAddressId" text,
  "shippingCity" text,
  "shippingDistrict" text,
  "coverageMatched" boolean,
  "subtotalGrossAmount" integer DEFAULT 0 NOT NULL,
  "qiftFeeAmount" integer DEFAULT 0 NOT NULL,
  "paymentProviderFeeAmount" integer DEFAULT 0 NOT NULL,
  "shippingFeeAmount" integer DEFAULT 0 NOT NULL,
  "totalGrossAmount" integer DEFAULT 0 NOT NULL,
  "acceptedAt" timestamp without time zone,
  "preparingAt" timestamp without time zone,
  "shippedAt" timestamp without time zone,
  "deliveredAt" timestamp without time zone,
  "cancelledAt" timestamp without time zone,
  "refundedAt" timestamp without time zone,
  "metadata" jsonb
);
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_giftSessionId_fkey" FOREIGN KEY ("giftSessionId") REFERENCES "GiftSession"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_giftSessionId_not_null" NOT NULL "giftSessionId";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_giftSessionRecipientId_fkey" FOREIGN KEY ("giftSessionRecipientId") REFERENCES "GiftSessionRecipient"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_giftSessionRecipientId_not_null" NOT NULL "giftSessionRecipientId";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_id_not_null" NOT NULL id;
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_paymentProviderFeeAmount_not_null" NOT NULL "paymentProviderFeeAmount";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_pkey" PRIMARY KEY (id);
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_qiftFeeAmount_not_null" NOT NULL "qiftFeeAmount";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_recipientUserId_not_null" NOT NULL "recipientUserId";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_shippingAddressId_fkey" FOREIGN KEY ("shippingAddressId") REFERENCES "Address"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_shippingFeeAmount_not_null" NOT NULL "shippingFeeAmount";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_status_not_null" NOT NULL status;
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_storeId_not_null" NOT NULL "storeId";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_subtotalGrossAmount_not_null" NOT NULL "subtotalGrossAmount";
ALTER TABLE "MerchantOrder" ADD CONSTRAINT "MerchantOrder_totalGrossAmount_not_null" NOT NULL "totalGrossAmount";
CREATE INDEX "MerchantOrder_giftSessionId_idx" ON public."MerchantOrder" USING btree ("giftSessionId");
CREATE INDEX "MerchantOrder_giftSessionRecipientId_idx" ON public."MerchantOrder" USING btree ("giftSessionRecipientId");
CREATE UNIQUE INDEX "MerchantOrder_giftSessionRecipientId_storeId_key" ON public."MerchantOrder" USING btree ("giftSessionRecipientId", "storeId");
CREATE INDEX "MerchantOrder_recipientUserId_status_idx" ON public."MerchantOrder" USING btree ("recipientUserId", status);
CREATE INDEX "MerchantOrder_storeId_status_idx" ON public."MerchantOrder" USING btree ("storeId", status);

-- ============ MerchantOrderLineItem  (rows=0) ============
CREATE TABLE "MerchantOrderLineItem" (
  "id" text NOT NULL,
  "merchantOrderId" text NOT NULL,
  "productId" text,
  "productNameAtPurchase" text NOT NULL,
  "productImageUrlAtPurchase" text,
  "unitPriceAtPurchase" integer NOT NULL,
  "quantity" integer NOT NULL,
  "lineTotalGrossAmount" integer NOT NULL,
  "requiredConfirmationTypes" ARRAY DEFAULT ARRAY[]::text[] NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL
);
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_id_not_null" NOT NULL id;
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_lineTotalGrossAmount_not_null" NOT NULL "lineTotalGrossAmount";
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_merchantOrderId_fkey" FOREIGN KEY ("merchantOrderId") REFERENCES "MerchantOrder"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_merchantOrderId_not_null" NOT NULL "merchantOrderId";
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_pkey" PRIMARY KEY (id);
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_productNameAtPurchase_not_null" NOT NULL "productNameAtPurchase";
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_quantity_not_null" NOT NULL quantity;
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_requiredConfirmationTypes_not_null" NOT NULL "requiredConfirmationTypes";
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_status_not_null" NOT NULL status;
ALTER TABLE "MerchantOrderLineItem" ADD CONSTRAINT "MerchantOrderLineItem_unitPriceAtPurchase_not_null" NOT NULL "unitPriceAtPurchase";
CREATE INDEX "MerchantOrderLineItem_merchantOrderId_idx" ON public."MerchantOrderLineItem" USING btree ("merchantOrderId");
CREATE INDEX "MerchantOrderLineItem_productId_idx" ON public."MerchantOrderLineItem" USING btree ("productId");

-- ============ MerchantOrderRecipientShipment  (rows=0) ============
CREATE TABLE "MerchantOrderRecipientShipment" (
  "id" text NOT NULL,
  "merchantOrderId" text NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "carrier" text,
  "trackingNumber" text,
  "shippedAt" timestamp without time zone,
  "deliveredAt" timestamp without time zone,
  "failedAt" timestamp without time zone,
  "cancelledAt" timestamp without time zone
);
ALTER TABLE "MerchantOrderRecipientShipment" ADD CONSTRAINT "MerchantOrderRecipientShipment_id_not_null" NOT NULL id;
ALTER TABLE "MerchantOrderRecipientShipment" ADD CONSTRAINT "MerchantOrderRecipientShipment_merchantOrderId_fkey" FOREIGN KEY ("merchantOrderId") REFERENCES "MerchantOrder"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "MerchantOrderRecipientShipment" ADD CONSTRAINT "MerchantOrderRecipientShipment_merchantOrderId_not_null" NOT NULL "merchantOrderId";
ALTER TABLE "MerchantOrderRecipientShipment" ADD CONSTRAINT "MerchantOrderRecipientShipment_pkey" PRIMARY KEY (id);
ALTER TABLE "MerchantOrderRecipientShipment" ADD CONSTRAINT "MerchantOrderRecipientShipment_status_not_null" NOT NULL status;
CREATE INDEX "MerchantOrderRecipientShipment_merchantOrderId_status_idx" ON public."MerchantOrderRecipientShipment" USING btree ("merchantOrderId", status);

-- ============ PaymentAllocation  (rows=0) ============
CREATE TABLE "PaymentAllocation" (
  "id" text NOT NULL,
  "paymentIntentId" text NOT NULL,
  "merchantOrderId" text NOT NULL,
  "itemSubtotalAmount" integer NOT NULL,
  "qiftFeeAmount" integer NOT NULL,
  "paymentProviderFeeAmount" integer NOT NULL,
  "shippingFeeAmount" integer NOT NULL,
  "netToMerchantAmount" integer NOT NULL,
  "settlementStatus" text DEFAULT 'held'::text NOT NULL,
  "settledAt" timestamp without time zone
);
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_id_not_null" NOT NULL id;
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_itemSubtotalAmount_not_null" NOT NULL "itemSubtotalAmount";
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_merchantOrderId_fkey" FOREIGN KEY ("merchantOrderId") REFERENCES "MerchantOrder"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_merchantOrderId_not_null" NOT NULL "merchantOrderId";
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_netToMerchantAmount_not_null" NOT NULL "netToMerchantAmount";
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentIntentId_not_null" NOT NULL "paymentIntentId";
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentProviderFeeAmount_not_null" NOT NULL "paymentProviderFeeAmount";
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY (id);
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_qiftFeeAmount_not_null" NOT NULL "qiftFeeAmount";
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_settlementStatus_not_null" NOT NULL "settlementStatus";
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_shippingFeeAmount_not_null" NOT NULL "shippingFeeAmount";
CREATE UNIQUE INDEX "PaymentAllocation_merchantOrderId_key" ON public."PaymentAllocation" USING btree ("merchantOrderId");
CREATE INDEX "PaymentAllocation_settlementStatus_idx" ON public."PaymentAllocation" USING btree ("settlementStatus");

-- ============ PaymentIntent  (rows=0) ============
CREATE TABLE "PaymentIntent" (
  "id" text NOT NULL,
  "giftSessionId" text NOT NULL,
  "providerName" text NOT NULL,
  "providerIntentId" text,
  "amountTotal" integer NOT NULL,
  "currencyCode" text DEFAULT 'SAR'::text NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "capturedAt" timestamp without time zone,
  "refundedAt" timestamp without time zone,
  "metadata" jsonb
);
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_amountTotal_not_null" NOT NULL "amountTotal";
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_currencyCode_not_null" NOT NULL "currencyCode";
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_giftSessionId_fkey" FOREIGN KEY ("giftSessionId") REFERENCES "GiftSession"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_giftSessionId_not_null" NOT NULL "giftSessionId";
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_id_not_null" NOT NULL id;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY (id);
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_providerName_not_null" NOT NULL "providerName";
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_status_not_null" NOT NULL status;
CREATE UNIQUE INDEX "PaymentIntent_giftSessionId_key" ON public."PaymentIntent" USING btree ("giftSessionId");

-- ============ RecipientConfirmationRequest  (rows=0) ============
CREATE TABLE "RecipientConfirmationRequest" (
  "id" text NOT NULL,
  "recipientUserId" text NOT NULL,
  "requestedByUserId" text NOT NULL,
  "giftId" text,
  "storeId" text,
  "type" text NOT NULL,
  "visibility" text NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "payload" jsonb,
  "metadata" jsonb,
  "requestedAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "expiresAt" timestamp without time zone,
  "resolvedAt" timestamp without time zone,
  "confirmedAt" timestamp without time zone,
  "giftSessionId" text,
  "giftSessionRecipientId" text,
  "merchantOrderId" text,
  "merchantOrderLineItemId" text,
  "shipmentId" text
);
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "Gift"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_giftSessionId_fkey" FOREIGN KEY ("giftSessionId") REFERENCES "GiftSession"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_giftSessionRecipientId_fkey" FOREIGN KEY ("giftSessionRecipientId") REFERENCES "GiftSessionRecipient"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_id_not_null" NOT NULL id;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_merchantOrderId_fkey" FOREIGN KEY ("merchantOrderId") REFERENCES "MerchantOrder"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_merchantOrderLineItemId_fkey" FOREIGN KEY ("merchantOrderLineItemId") REFERENCES "MerchantOrderLineItem"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_pkey" PRIMARY KEY (id);
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_recipientUserId_not_null" NOT NULL "recipientUserId";
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_requestedAt_not_null" NOT NULL "requestedAt";
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_requestedByUserId_not_null" NOT NULL "requestedByUserId";
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "MerchantOrderRecipientShipment"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_status_not_null" NOT NULL status;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_type_not_null" NOT NULL type;
ALTER TABLE "RecipientConfirmationRequest" ADD CONSTRAINT "RecipientConfirmationRequest_visibility_not_null" NOT NULL visibility;
CREATE INDEX "RecipientConfirmationRequest_giftId_idx" ON public."RecipientConfirmationRequest" USING btree ("giftId");
CREATE INDEX "RecipientConfirmationRequest_giftSessionId_status_idx" ON public."RecipientConfirmationRequest" USING btree ("giftSessionId", status);
CREATE INDEX "RecipientConfirmationRequest_giftSessionRecipientId_status_idx" ON public."RecipientConfirmationRequest" USING btree ("giftSessionRecipientId", status);
CREATE INDEX "RecipientConfirmationRequest_merchantOrderId_status_idx" ON public."RecipientConfirmationRequest" USING btree ("merchantOrderId", status);
CREATE INDEX "RecipientConfirmationRequest_merchantOrderLineItemId_status_idx" ON public."RecipientConfirmationRequest" USING btree ("merchantOrderLineItemId", status);
CREATE INDEX "RecipientConfirmationRequest_recipientUserId_status_idx" ON public."RecipientConfirmationRequest" USING btree ("recipientUserId", status);
CREATE INDEX "RecipientConfirmationRequest_status_expiresAt_idx" ON public."RecipientConfirmationRequest" USING btree (status, "expiresAt");
CREATE INDEX "RecipientConfirmationRequest_storeId_status_idx" ON public."RecipientConfirmationRequest" USING btree ("storeId", status);

-- ============ RefundRequest  (rows=0) ============
CREATE TABLE "RefundRequest" (
  "id" text NOT NULL,
  "requestedByUserId" text NOT NULL,
  "requestedByRole" text NOT NULL,
  "scope" text NOT NULL,
  "giftSessionId" text,
  "giftSessionRecipientId" text,
  "merchantOrderId" text,
  "merchantOrderLineItemId" text,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "reasonCode" text NOT NULL,
  "amountRequested" integer NOT NULL,
  "amountApproved" integer,
  "metadata" jsonb,
  "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "resolvedAt" timestamp without time zone
);
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_amountRequested_not_null" NOT NULL "amountRequested";
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_createdAt_not_null" NOT NULL "createdAt";
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_giftSessionId_fkey" FOREIGN KEY ("giftSessionId") REFERENCES "GiftSession"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_giftSessionRecipientId_fkey" FOREIGN KEY ("giftSessionRecipientId") REFERENCES "GiftSessionRecipient"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_id_not_null" NOT NULL id;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_merchantOrderId_fkey" FOREIGN KEY ("merchantOrderId") REFERENCES "MerchantOrder"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_merchantOrderLineItemId_fkey" FOREIGN KEY ("merchantOrderLineItemId") REFERENCES "MerchantOrderLineItem"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_pkey" PRIMARY KEY (id);
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_reasonCode_not_null" NOT NULL "reasonCode";
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_requestedByRole_not_null" NOT NULL "requestedByRole";
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_requestedByUserId_not_null" NOT NULL "requestedByUserId";
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_scope_not_null" NOT NULL scope;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_status_not_null" NOT NULL status;
CREATE INDEX "RefundRequest_giftSessionId_status_idx" ON public."RefundRequest" USING btree ("giftSessionId", status);
CREATE INDEX "RefundRequest_merchantOrderId_status_idx" ON public."RefundRequest" USING btree ("merchantOrderId", status);
CREATE INDEX "RefundRequest_requestedByUserId_status_idx" ON public."RefundRequest" USING btree ("requestedByUserId", status);
CREATE INDEX "RefundRequest_scope_status_idx" ON public."RefundRequest" USING btree (scope, status);

-- ============ ShipmentLineItem  (rows=0) ============
CREATE TABLE "ShipmentLineItem" (
  "id" text NOT NULL,
  "shipmentId" text NOT NULL,
  "merchantOrderLineItemId" text NOT NULL,
  "quantityShipped" integer NOT NULL
);
ALTER TABLE "ShipmentLineItem" ADD CONSTRAINT "ShipmentLineItem_id_not_null" NOT NULL id;
ALTER TABLE "ShipmentLineItem" ADD CONSTRAINT "ShipmentLineItem_merchantOrderLineItemId_fkey" FOREIGN KEY ("merchantOrderLineItemId") REFERENCES "MerchantOrderLineItem"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "ShipmentLineItem" ADD CONSTRAINT "ShipmentLineItem_merchantOrderLineItemId_not_null" NOT NULL "merchantOrderLineItemId";
ALTER TABLE "ShipmentLineItem" ADD CONSTRAINT "ShipmentLineItem_pkey" PRIMARY KEY (id);
ALTER TABLE "ShipmentLineItem" ADD CONSTRAINT "ShipmentLineItem_quantityShipped_not_null" NOT NULL "quantityShipped";
ALTER TABLE "ShipmentLineItem" ADD CONSTRAINT "ShipmentLineItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "MerchantOrderRecipientShipment"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "ShipmentLineItem" ADD CONSTRAINT "ShipmentLineItem_shipmentId_not_null" NOT NULL "shipmentId";
CREATE UNIQUE INDEX "ShipmentLineItem_shipmentId_merchantOrderLineItemId_key" ON public."ShipmentLineItem" USING btree ("shipmentId", "merchantOrderLineItemId");

-- ============ zz_legacy_FinancialLedgerEntry_shadow  (rows=0) ============
CREATE TABLE "zz_legacy_FinancialLedgerEntry_shadow" (
  "id" text NOT NULL,
  "giftSessionId" text NOT NULL,
  "merchantOrderId" text,
  "paymentAllocationId" text,
  "eventType" text NOT NULL,
  "amount" integer NOT NULL,
  "currencyCode" text DEFAULT 'SAR'::text NOT NULL,
  "reasonCode" text NOT NULL,
  "metadata" jsonb,
  "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_amount_not_null" NOT NULL amount;
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_createdAt_not_null" NOT NULL "createdAt";
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_currencyCode_not_null" NOT NULL "currencyCode";
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_eventType_not_null" NOT NULL "eventType";
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_giftSessionId_fkey" FOREIGN KEY ("giftSessionId") REFERENCES "GiftSession"(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_giftSessionId_not_null" NOT NULL "giftSessionId";
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_id_not_null" NOT NULL id;
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_merchantOrderId_fkey" FOREIGN KEY ("merchantOrderId") REFERENCES "MerchantOrder"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_paymentAllocationId_fkey" FOREIGN KEY ("paymentAllocationId") REFERENCES "PaymentAllocation"(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "FinancialLedgerEntry_reasonCode_not_null" NOT NULL "reasonCode";
ALTER TABLE "zz_legacy_FinancialLedgerEntry_shadow" ADD CONSTRAINT "zz_legacy_FinancialLedgerEntry_shadow_pkey" PRIMARY KEY (id);
CREATE INDEX "FinancialLedgerEntry_giftSessionId_createdAt_idx" ON public."zz_legacy_FinancialLedgerEntry_shadow" USING btree ("giftSessionId", "createdAt");
CREATE INDEX "FinancialLedgerEntry_merchantOrderId_createdAt_idx" ON public."zz_legacy_FinancialLedgerEntry_shadow" USING btree ("merchantOrderId", "createdAt");

-- ============ RiskSignalEvent  (rows=1) ============
CREATE TABLE "RiskSignalEvent" (
  "id" text NOT NULL,
  "userId" text,
  "actorType" text NOT NULL,
  "eventType" text NOT NULL,
  "severity" text NOT NULL,
  "targetType" text,
  "targetId" text,
  "reasonCode" text NOT NULL,
  "metadata" jsonb,
  "riskScoreDelta" integer,
  "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
ALTER TABLE "RiskSignalEvent" ADD CONSTRAINT "RiskSignalEvent_actorType_not_null" NOT NULL "actorType";
ALTER TABLE "RiskSignalEvent" ADD CONSTRAINT "RiskSignalEvent_createdAt_not_null" NOT NULL "createdAt";
ALTER TABLE "RiskSignalEvent" ADD CONSTRAINT "RiskSignalEvent_eventType_not_null" NOT NULL "eventType";
ALTER TABLE "RiskSignalEvent" ADD CONSTRAINT "RiskSignalEvent_id_not_null" NOT NULL id;
ALTER TABLE "RiskSignalEvent" ADD CONSTRAINT "RiskSignalEvent_pkey" PRIMARY KEY (id);
ALTER TABLE "RiskSignalEvent" ADD CONSTRAINT "RiskSignalEvent_reasonCode_not_null" NOT NULL "reasonCode";
ALTER TABLE "RiskSignalEvent" ADD CONSTRAINT "RiskSignalEvent_severity_not_null" NOT NULL severity;
CREATE INDEX "RiskSignalEvent_eventType_createdAt_idx" ON public."RiskSignalEvent" USING btree ("eventType", "createdAt");
CREATE INDEX "RiskSignalEvent_severity_createdAt_idx" ON public."RiskSignalEvent" USING btree (severity, "createdAt");
CREATE INDEX "RiskSignalEvent_severity_eventType_createdAt_idx" ON public."RiskSignalEvent" USING btree (severity, "eventType", "createdAt");
CREATE INDEX "RiskSignalEvent_userId_createdAt_idx" ON public."RiskSignalEvent" USING btree ("userId", "createdAt");
