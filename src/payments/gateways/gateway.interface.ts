// Contract that every real payment gateway will implement when we wire up
// mada, knet, qpay, benefit, oman_net, Apple Pay and the card networks.
// Keeping the interface here means the orders + payments services can stay
// gateway-agnostic and only depend on the registry below.

import type { PaymentProvider } from '../providers';

export interface PaymentGatewayInitiateInput {
  orderId: string;
  amount: number;
  currency: string;
  // The wallet/card token, customer ip, return urls etc. would land here
  // when the real integrations are added.
}

export interface PaymentGatewayInitiateResult {
  providerPaymentId: string;
  // For redirect-based flows we'll surface a checkout URL.
  redirectUrl?: string;
}

export interface PaymentGateway {
  readonly key: PaymentProvider;
  initiate(
    input: PaymentGatewayInitiateInput,
  ): Promise<PaymentGatewayInitiateResult>;
  // Confirm is what the bank-side webhook will call once the user authorises.
  confirm(providerPaymentId: string): Promise<{ status: 'paid' | 'failed' }>;
}
