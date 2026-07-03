// Pure invoice amount decomposition for a corporate campaign. Side-effect
// free so it is unit-testable in isolation.
//
// Qift is an AGENT, not the seller (canonical). This helper decomposes a
// campaign of N identical gifts into its two commercial legs:
//   subtotal    = unitAmount * recipientCount        (goods value — the
//                                                     MERCHANT's revenue;
//                                                     Qift only facilitates)
//   platformFee = serviceFeeFor(unitAmount) * count  (Qift service revenue)
//   total       = subtotal + platformFee             (combined campaign
//                                                     value across BOTH
//                                                     legs, ex-VAT)
//
// NOTE: `total` here is the combined campaign value, NOT the Qift invoice
// total. The Qift service invoice bills the platform fee + VAT on the fee
// only (see computeTax, agent_fee_only); the goods subtotal is billed by
// the merchant on the separate merchant (goods) invoice. This helper feeds
// computeTax and the future Campaign Billing Summary, which recombine the
// legs for display.
//
// The per-unit platform fee reuses the FeeEngine's serviceFeeFor so the
// corporate and consumer paths charge the same Qift rate from one source
// of truth.

import { serviceFeeFor, FEE_POLICY_VERSION } from '../fees/fee-engine';
import { addMoney, mulMoney } from '../fees/money';

export type InvoiceAmounts = {
  unitAmount: number;
  recipientCount: number;
  subtotalAmount: number;
  platformFeeAmount: number;
  totalAmount: number;
  feePolicyVersion: string;
};

export function computeInvoiceAmounts(
  unitAmount: number,
  recipientCount: number,
): InvoiceAmounts {
  // FIN-3: exact minor-unit math — 19.99 × 3 is 59.97 here, never
  // 59.96999999999999; what persists to the NUMERIC invoice columns is
  // already exact.
  const subtotalAmount = mulMoney(unitAmount, recipientCount);
  const platformFeeAmount = mulMoney(serviceFeeFor(unitAmount), recipientCount);
  const totalAmount = addMoney([subtotalAmount, platformFeeAmount]);
  return {
    unitAmount,
    recipientCount,
    subtotalAmount,
    platformFeeAmount,
    totalAmount,
    feePolicyVersion: FEE_POLICY_VERSION,
  };
}
