// Pure invoice amount math for a corporate campaign. Side-effect free so
// it is unit-testable in isolation.
//
// The invoice bills the company for a campaign of N identical gifts:
//   subtotal    = unitAmount * recipientCount        (gift value)
//   platformFee = serviceFeeFor(unitAmount) * count  (Qift revenue)
//   total       = subtotal + platformFee             (company owes Qift)
//
// The per-unit platform fee reuses the FeeEngine's serviceFeeFor so the
// corporate and consumer paths charge the same Qift rate from one source
// of truth.

import { serviceFeeFor, FEE_POLICY_VERSION } from '../fees/fee-engine';

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
  const subtotalAmount = unitAmount * recipientCount;
  const platformFeeAmount = serviceFeeFor(unitAmount) * recipientCount;
  const totalAmount = subtotalAmount + platformFeeAmount;
  return {
    unitAmount,
    recipientCount,
    subtotalAmount,
    platformFeeAmount,
    totalAmount,
    feePolicyVersion: FEE_POLICY_VERSION,
  };
}
