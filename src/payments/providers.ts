// Single source of truth for which payment providers are allowed in each
// country. Used by the orders endpoint to validate the chosen provider and
// by the frontend to render the right payment-method picker.
//
// Future real-gateway integrations should live in `./gateways/` and register
// themselves keyed by the same provider id used here.

export type PaymentProvider =
  | 'mada'
  | 'knet'
  | 'qpay'
  | 'benefit'
  | 'oman_net'
  | 'apple_pay'
  | 'visa'
  | 'mastercard';

const COUNTRY_PROVIDERS: Record<string, PaymentProvider[]> = {
  SA: ['mada', 'apple_pay', 'visa', 'mastercard'],
  KW: ['knet', 'apple_pay', 'visa', 'mastercard'],
  AE: ['apple_pay', 'visa', 'mastercard'],
  QA: ['qpay', 'apple_pay', 'visa', 'mastercard'],
  BH: ['benefit', 'apple_pay', 'visa', 'mastercard'],
  OM: ['oman_net', 'apple_pay', 'visa', 'mastercard'],
};

const FALLBACK_PROVIDERS: PaymentProvider[] = ['visa', 'mastercard'];

export function getPaymentProvidersByCountry(
  country: string | null | undefined,
): PaymentProvider[] {
  if (!country) return FALLBACK_PROVIDERS;
  const code = country.trim().toUpperCase();
  return COUNTRY_PROVIDERS[code] ?? FALLBACK_PROVIDERS;
}

export function validatePaymentProvider(
  country: string | null | undefined,
  provider: string | null | undefined,
): provider is PaymentProvider {
  if (!provider) return false;
  return getPaymentProvidersByCountry(country).includes(
    provider as PaymentProvider,
  );
}
