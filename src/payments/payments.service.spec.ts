import { PaymentsService } from './payments.service';
import { LEDGER_REASON } from '../financial/order-ledger';

// The mock gateway always authorises — we are testing the ledger wiring,
// not the (mocked) PSP.
jest.mock('./gateways/registry', () => ({
  getGateway: () => ({
    key: 'mada',
    initiate: jest.fn().mockResolvedValue({ providerPaymentId: 'pp-1' }),
    confirm: jest.fn().mockResolvedValue({ status: 'paid' }),
  }),
}));

const BUYER = 'buyer-1';

function pendingOrderRow() {
  return {
    id: 'order-1',
    userId: BUYER,
    status: 'pending',
    gift: null,
    payment: null,
    country: 'SA',
    paymentProvider: 'mada',
    currency: 'SAR',
    receiverUsername: 'friend',
    productName: 'Bouquet',
    storeName: 'Rosary',
    message: null,
    isAnonymous: false,
    isSurprise: false,
    mediaUrl: null,
    mediaType: null,
    productId: 'prod-1',
    storeId: 'store-1',
    occasionId: null,
    // server-authoritative FeeEngine amounts: 500 + 15 + 15 = 530
    productPrice: 500,
    serviceFee: 15,
    deliveryFee: 15,
    totalAmount: 530,
  };
}

function paidOrderRow() {
  return {
    ...pendingOrderRow(),
    status: 'paid',
    giftId: 'gift-1',
    payment: { id: 'pay-1' },
    gift: { id: 'gift-1' },
  };
}

function build() {
  const gifts = {
    create: jest.fn().mockResolvedValue({ gift: { id: 'gift-1' }, replayed: false }),
  };
  const ledger = {
    findByOrder: jest.fn().mockResolvedValue([]),
    record: jest.fn().mockResolvedValue({ id: 'ledger-x' }),
  };
  const txPayment = { upsert: jest.fn().mockResolvedValue({}) };
  const txOrder = { update: jest.fn().mockResolvedValue(paidOrderRow()) };
  const prisma = {
    order: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    payment: { upsert: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ payment: txPayment, order: txOrder }),
    ),
  };
  const service = new PaymentsService(
    prisma as never,
    gifts as never,
    ledger as never,
  );
  return { service, prisma, gifts, ledger };
}

function reasonCodes(ledger: { record: jest.Mock }) {
  return ledger.record.mock.calls.map((c) => c[0].reasonCode).sort();
}

describe('PaymentsService — ledger wiring on paid orders', () => {
  it('posts the expected ledger entries with FeeEngine amounts on a paid order', async () => {
    const { service, prisma, ledger } = build();
    prisma.order.findUnique.mockResolvedValue(pendingOrderRow());

    const out = await service.confirmMock('order-1', BUYER);
    expect(out.order.status).toBe('paid');

    expect(reasonCodes(ledger)).toEqual(
      [
        LEDGER_REASON.DELIVERY_FEE,
        LEDGER_REASON.MERCHANT_PAYABLE,
        LEDGER_REASON.ORDER_PAID,
        LEDGER_REASON.QIFT_SERVICE_FEE,
      ].sort(),
    );

    const byReason = Object.fromEntries(
      ledger.record.mock.calls.map((c) => [c[0].reasonCode, c[0]]),
    );
    expect(byReason[LEDGER_REASON.ORDER_PAID].amount).toBe(530); // totalAmount
    expect(byReason[LEDGER_REASON.QIFT_SERVICE_FEE].amount).toBe(15); // serviceFee
    expect(byReason[LEDGER_REASON.MERCHANT_PAYABLE].amount).toBe(500); // productPrice
    expect(byReason[LEDGER_REASON.DELIVERY_FEE].amount).toBe(15); // deliveryFee
  });

  it('does not include recipient PII in any ledger entry', async () => {
    const { service, prisma, ledger } = build();
    prisma.order.findUnique.mockResolvedValue(pendingOrderRow());
    await service.confirmMock('order-1', BUYER);
    for (const call of ledger.record.mock.calls) {
      const flat = JSON.stringify(call[0]).toLowerCase();
      for (const banned of ['friend', 'address', 'phone', 'message', 'receiver']) {
        expect(flat).not.toContain(banned);
      }
    }
  });

  it('does not duplicate ledger entries on a repeated confirmation', async () => {
    const { service, prisma, ledger } = build();
    // First confirm: pending → paid, posts entries.
    prisma.order.findUnique.mockResolvedValueOnce(pendingOrderRow());
    await service.confirmMock('order-1', BUYER);
    const firstCount = ledger.record.mock.calls.length;
    expect(firstCount).toBe(4);

    // Retry: the order is already paid, and its entries already exist.
    prisma.order.findUnique.mockResolvedValue(paidOrderRow());
    ledger.findByOrder.mockResolvedValue([{ id: 'ledger-x' }]); // already posted
    await service.confirmMock('order-1', BUYER);

    expect(ledger.record.mock.calls.length).toBe(firstCount); // no new writes
  });

  it('treats a racing duplicate write (P2002) as already-posted, not an error', async () => {
    const { service, prisma, ledger } = build();
    prisma.order.findUnique.mockResolvedValue(pendingOrderRow());
    const p2002 = Object.assign(
      new (require('@prisma/client').Prisma.PrismaClientKnownRequestError)(
        'dup',
        { code: 'P2002', clientVersion: 'x' },
      ),
    );
    ledger.record.mockRejectedValueOnce(p2002); // first entry races, rest succeed

    const out = await service.confirmMock('order-1', BUYER);
    expect(out.order.status).toBe('paid'); // confirmation still succeeds
  });

  it('a ledger failure NEVER fails the payment (best-effort, logged)', async () => {
    const { service, prisma, ledger } = build();
    prisma.order.findUnique.mockResolvedValue(pendingOrderRow());
    // Simulate a hard ledger outage.
    ledger.record.mockRejectedValue(new Error('ledger db down'));
    const errSpy = jest
      .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => {});

    const out = await service.confirmMock('order-1', BUYER);

    // Payment stands: the sale completed, the gift exists.
    expect(out.order.status).toBe('paid');
    expect(out.gift).toEqual({ id: 'gift-1' });
    // The failure was recorded loudly for ops to retry.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[ledger-failed]'));
  });
});
