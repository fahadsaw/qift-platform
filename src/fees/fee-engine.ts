// Qift FeeEngine — the single, authoritative source of truth for the
// platform's fee arithmetic.
//
// WHY THIS EXISTS: the checkout page previously computed the Qift service
// fee and the grand total in the browser and the backend persisted those
// numbers verbatim, so a tampered client could set its own fee/total.
// Order creation now computes every charged amount from here; the client
// supplies cart FACTS only (which product, which delivery speed). Payout
// derivation references the same rate, so there is one number to change.
//
// The arithmetic mirrors the historical checkout math exactly, so an
// honest client sees the same total it always did:
//   serviceFee = max(MIN, round(itemSubtotal * RATE))
//   deliveryFee = fast ? FAST : STANDARD
//   grandTotal  = itemSubtotal + deliveryFee + serviceFee
//
// Bump FEE_POLICY_VERSION whenever any constant below changes, so a
// future ledger/invoice can record which policy produced a given charge.

export const QIFT_SERVICE_FEE_RATE = 0.03; // 3% of the item subtotal
export const QIFT_MIN_SERVICE_FEE = 5; // SAR floor on the service fee
export const FAST_DELIVERY_FEE = 15; // SAR, flat, for the fast option
export const STANDARD_DELIVERY_FEE = 0; // SAR, standard / same-day
export const FEE_POLICY_VERSION = 'fee-v1';

export type DeliverySpeed = 'same_day' | 'fast';

export type FeeInput = {
  // Server-resolved item subtotal (authoritative catalog price for a real
  // product; a client-supplied price only for sample/demo flows).
  itemSubtotal: number;
  deliverySpeed: DeliverySpeed;
};

// Immutable description of the rule that produced a breakdown. Returned
// alongside the amounts so a future ledger/invoice can prove which policy
// applied without a live lookup.
export type FeePolicy = {
  serviceFeeRate: number;
  minServiceFee: number;
  fastDeliveryFee: number;
  standardDeliveryFee: number;
  version: string;
};

export type FeeBreakdown = {
  itemSubtotal: number;
  deliveryFee: number;
  serviceFee: number;
  grandTotal: number;
  policy: FeePolicy;
};

export function feePolicySnapshot(): FeePolicy {
  return {
    serviceFeeRate: QIFT_SERVICE_FEE_RATE,
    minServiceFee: QIFT_MIN_SERVICE_FEE,
    fastDeliveryFee: FAST_DELIVERY_FEE,
    standardDeliveryFee: STANDARD_DELIVERY_FEE,
    version: FEE_POLICY_VERSION,
  };
}

// The Qift platform service fee for a given item subtotal.
export function serviceFeeFor(itemSubtotal: number): number {
  return Math.max(
    QIFT_MIN_SERVICE_FEE,
    Math.round(itemSubtotal * QIFT_SERVICE_FEE_RATE),
  );
}

// The delivery fee for a resolved delivery speed.
export function deliveryFeeFor(speed: DeliverySpeed): number {
  return speed === 'fast' ? FAST_DELIVERY_FEE : STANDARD_DELIVERY_FEE;
}

// Authoritative charge computation. This is the only place order totals
// are produced.
export function computeFees(input: FeeInput): FeeBreakdown {
  const itemSubtotal = input.itemSubtotal;
  const deliveryFee = deliveryFeeFor(input.deliverySpeed);
  const serviceFee = serviceFeeFor(itemSubtotal);
  const grandTotal = itemSubtotal + deliveryFee + serviceFee;
  return {
    itemSubtotal,
    deliveryFee,
    serviceFee,
    grandTotal,
    policy: feePolicySnapshot(),
  };
}
