// Maps a trusted, PAID order to its append-only ledger entries.
//
// Pure + side-effect free so it is unit-testable in isolation. The
// amounts come straight from the Order's server-authoritative columns
// (written by the FeeEngine in PR 1) — never from the client. The four
// reason codes allocate the captured total:
//
//   ORDER_PAID (credit, totalAmount)             = cash captured from the sender
//     = QIFT_SERVICE_FEE (credit, serviceFee)    Qift revenue
//     + MERCHANT_PAYABLE (debit, productPrice)   owed to the merchant
//     + DELIVERY_FEE     (debit, deliveryFee)    owed for delivery
//
// direction is from Qift's perspective: `credit` = value Qift
// receives/earns, `debit` = value Qift owes. The precise GL account
// mapping is deferred to the settlement/invoice PRs; this substrate
// records the amounts, the direction hint, and the correlation ids.
//
// PRIVACY: metadata carries only non-PII financial context (fee-policy
// version + payment provider). No receiverUsername, address, phone,
// message or claim data is ever included. FinancialLedgerService also
// strips a sensitive-key denylist as defense-in-depth.

import { FEE_POLICY_VERSION } from '../fees/fee-engine';
import type { RecordLedgerInput } from './financial-ledger.service';

// Reason codes for order-lifecycle postings. One per (order, reasonCode)
// — enforced by the @@unique([orderId, reasonCode]) idempotency key.
export const LEDGER_REASON = {
  ORDER_PAID: 'ORDER_PAID',
  QIFT_SERVICE_FEE: 'QIFT_SERVICE_FEE',
  MERCHANT_PAYABLE: 'MERCHANT_PAYABLE',
  DELIVERY_FEE: 'DELIVERY_FEE',
} as const;

// The Order fields this mapping needs. Kept minimal so callers pass a
// narrow projection and no PII leaks in by accident.
export type PaidOrderForLedger = {
  id: string;
  userId: string;
  storeId: string | null;
  productPrice: number;
  serviceFee: number;
  deliveryFee: number;
  totalAmount: number;
  currency: string;
  paymentProvider: string;
};

export function buildOrderLedgerEntries(
  order: PaidOrderForLedger,
  paymentId: string | null,
): RecordLedgerInput[] {
  const base = {
    currency: order.currency,
    orderId: order.id,
    paymentId: paymentId ?? undefined,
    storeId: order.storeId ?? undefined,
    metadata: {
      feePolicyVersion: FEE_POLICY_VERSION,
      paymentProvider: order.paymentProvider,
    },
  };

  const entries: RecordLedgerInput[] = [];

  // Cash captured from the sender.
  entries.push({
    ...base,
    eventType: 'order.paid',
    reasonCode: LEDGER_REASON.ORDER_PAID,
    actorType: 'user',
    actorId: order.userId,
    amount: order.totalAmount,
    direction: 'credit',
    counterpartyType: 'sender',
  });

  // Qift platform revenue (always present — serviceFee has a floor).
  if (order.serviceFee > 0) {
    entries.push({
      ...base,
      eventType: 'qift.service_fee.accrued',
      reasonCode: LEDGER_REASON.QIFT_SERVICE_FEE,
      actorType: 'system',
      amount: order.serviceFee,
      direction: 'credit',
      counterpartyType: 'qift',
    });
  }

  // Amount owed to the merchant for the product — only when the order is
  // actually linked to a store (sample/demo flows carry no storeId).
  if (order.storeId && order.productPrice > 0) {
    entries.push({
      ...base,
      eventType: 'merchant.payable.accrued',
      reasonCode: LEDGER_REASON.MERCHANT_PAYABLE,
      actorType: 'system',
      amount: order.productPrice,
      direction: 'debit',
      counterpartyType: 'merchant',
    });
  }

  // Delivery fee, only when one was charged.
  if (order.deliveryFee > 0) {
    entries.push({
      ...base,
      eventType: 'delivery.fee.accrued',
      reasonCode: LEDGER_REASON.DELIVERY_FEE,
      actorType: 'system',
      amount: order.deliveryFee,
      direction: 'debit',
      counterpartyType: 'merchant',
    });
  }

  return entries;
}
