// Central registry of payment-provider implementations. Today every entry is
// a `MockGateway`; swap individual entries for the real client (mada,
// MyFatoorah/KNET, QPay, Benefit, OmanNet, Apple Pay, Stripe/Checkout.com for
// Visa/Mastercard) when integrating each provider.

import type { PaymentProvider } from '../providers';
import type { PaymentGateway } from './gateway.interface';
import { MockGateway } from './mock.gateway';

export const PAYMENT_GATEWAYS: Record<PaymentProvider, PaymentGateway> = {
  mada: new MockGateway('mada'),
  knet: new MockGateway('knet'),
  qpay: new MockGateway('qpay'),
  benefit: new MockGateway('benefit'),
  oman_net: new MockGateway('oman_net'),
  apple_pay: new MockGateway('apple_pay'),
  visa: new MockGateway('visa'),
  mastercard: new MockGateway('mastercard'),
};

export function getGateway(provider: PaymentProvider): PaymentGateway {
  return PAYMENT_GATEWAYS[provider];
}
