import { randomUUID } from 'node:crypto';
import type { PaymentProvider } from '../providers';
import type {
  PaymentGateway,
  PaymentGatewayInitiateInput,
  PaymentGatewayInitiateResult,
} from './gateway.interface';

// Stand-in gateway used until we wire each real provider (mada / knet / etc.).
// `POST /payments/mock/confirm` calls this directly so the rest of the stack
// can be built and tested today without a sandbox account.
export class MockGateway implements PaymentGateway {
  constructor(public readonly key: PaymentProvider) {}

  initiate(
    input: PaymentGatewayInitiateInput,
  ): Promise<PaymentGatewayInitiateResult> {
    return Promise.resolve({
      providerPaymentId: `mock_${this.key}_${randomUUID()}`,
    });
  }

  confirm(providerPaymentId: string): Promise<{ status: 'paid' | 'failed' }> {
    // The mock always succeeds; future real implementations will hit the
    // bank/PSP API here.
    void providerPaymentId;
    return Promise.resolve({ status: 'paid' });
  }
}
