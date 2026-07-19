import { BadRequestException } from '@nestjs/common';
import { OrdersService, type CreateOrderInput } from './orders.service';

// PR 1 — server-side FeeEngine security tests.
//
// Proves that the browser is no longer trusted for money: the fee, the
// delivery fee, the grand total and (for real catalog products) the item
// subtotal are all recomputed server-side, so a tampered client cannot
// under-price a gift or zero out the Qift fee.

const SENDER_ID = 'sender-1';

// Minimal prisma double covering exactly the calls create() makes.
function buildPrisma() {
  const order = {
    create: jest.fn(),
    // QP allocation uniqueness probe (Track A.5) — nothing taken.
    findUnique: jest.fn().mockResolvedValue(null),
  };
  const user = {
    findUnique: jest.fn().mockResolvedValue({ qiftUsername: 'sender' }),
    findFirst: jest.fn().mockResolvedValue({ id: 'receiver-1' }),
  };
  const address = {
    findFirst: jest.fn().mockResolvedValue({ id: 'addr-1' }), // default address exists
  };
  // Echo the persisted data back so tests can assert on it.
  order.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'order-1', payment: null, gift: null, ...data }),
  );
  return { order, user, address };
}

function buildService(opts: { catalogPrice: number | null }) {
  const prisma = buildPrisma();
  const users = { canDeliverFast: jest.fn().mockResolvedValue(true) };
  const products = {
    // Real catalog product → returns an authoritative price. Sample/demo
    // flow (no productId) → checkAvailability returns null.
    checkAvailability: jest
      .fn()
      .mockResolvedValue(
        opts.catalogPrice == null
          ? null
          : { id: 'prod-1', storeId: 'store-1', price: opts.catalogPrice },
      ),
  };
  const service = new OrdersService(
    prisma as never,
    users as never,
    products as never,
  );
  return { service, prisma, users, products };
}

// A realistic "current frontend" payload: it still sends the fee fields.
function baseBody(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    receiverUsername: 'friend',
    productName: 'Bouquet',
    storeName: 'Rosary',
    currency: 'SAR',
    country: 'SA',
    paymentProvider: 'mada',
    productId: 'prod-1',
    ...overrides,
  };
}

// Pull the data object handed to prisma.order.create.
function persisted(prisma: ReturnType<typeof buildPrisma>) {
  return prisma.order.create.mock.calls[0][0].data as Record<string, number>;
}

describe('OrdersService.create — server-side fee authority', () => {
  it('ignores client serviceFee / totalAmount and recomputes them', async () => {
    const { service, prisma } = buildService({ catalogPrice: 500 });
    await service.create(
      baseBody({ serviceFee: 0, deliveryFee: 0, totalAmount: 1 }),
      SENDER_ID,
    );
    const data = persisted(prisma);
    expect(data.serviceFee).toBe(15); // round(500 * 0.03), NOT the client's 0
    expect(data.deliveryFee).toBe(0);
    expect(data.totalAmount).toBe(515); // NOT the client's 1
  });

  it('uses the authoritative catalog price, not the client productPrice', async () => {
    const { service, prisma } = buildService({ catalogPrice: 500 });
    // Malicious client claims the 500 SAR product costs 1 SAR.
    await service.create(baseBody({ productPrice: 1 }), SENDER_ID);
    const data = persisted(prisma);
    expect(data.productPrice).toBe(500); // catalog wins
    expect(data.serviceFee).toBe(15);
    expect(data.totalAmount).toBe(515);
  });

  it('a malicious grand total never becomes authoritative', async () => {
    const { service, prisma } = buildService({ catalogPrice: 500 });
    await service.create(
      baseBody({ totalAmount: 1, serviceFee: 0 }),
      SENDER_ID,
    );
    expect(persisted(prisma).totalAmount).toBe(515);
  });

  it('maps a legacy deliveryFee=15 to fast and recomputes the fee', async () => {
    const { service, prisma } = buildService({ catalogPrice: 100 });
    await service.create(baseBody({ deliveryFee: 15 }), SENDER_ID);
    const data = persisted(prisma);
    expect(data.deliveryFee).toBe(15); // recomputed from the resolved speed
    expect(data.serviceFee).toBe(5); // max(5, round(100*0.03))
    expect(data.totalAmount).toBe(120); // 100 + 15 + 5
  });

  it('honours an explicit deliverySpeed fact over any legacy number', async () => {
    const { service, prisma } = buildService({ catalogPrice: 100 });
    await service.create(
      baseBody({ deliverySpeed: 'fast', deliveryFee: 0 }),
      SENDER_ID,
    );
    expect(persisted(prisma).deliveryFee).toBe(15);
  });

  it('rejects a tampered deliveryFee that is not a legitimate menu value', async () => {
    const { service } = buildService({ catalogPrice: 100 });
    await expect(
      service.create(baseBody({ deliveryFee: 999 }), SENDER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('remains compatible with the current frontend payload shape', async () => {
    // Exactly what checkout sends today: productPrice + all three fee
    // fields, no deliverySpeed. Must succeed and persist server values.
    const { service, prisma } = buildService({ catalogPrice: 500 });
    const created = await service.create(
      baseBody({
        productPrice: 500,
        serviceFee: 15,
        deliveryFee: 0,
        totalAmount: 515,
      }),
      SENDER_ID,
    );
    expect(created).toMatchObject({ id: 'order-1' });
    const data = persisted(prisma);
    expect(data).toMatchObject({
      productPrice: 500,
      serviceFee: 15,
      totalAmount: 515,
    });
  });

  it('falls back to the client productPrice for sample/demo flows (no productId)', async () => {
    const { service, prisma } = buildService({ catalogPrice: null });
    await service.create(
      baseBody({ productId: undefined, productPrice: 200 }),
      SENDER_ID,
    );
    const data = persisted(prisma);
    expect(data.productPrice).toBe(200);
    expect(data.serviceFee).toBe(6); // round(200 * 0.03)
    expect(data.totalAmount).toBe(206);
  });
});

describe('QP order reference (Track A.5 PR 6)', () => {
  it('every created order carries a canonical QP reference', async () => {
    const { service, prisma } = buildService({ catalogPrice: 100 });
    await service.create(baseBody(), SENDER_ID);
    const data = persisted(prisma);
    expect(String(data.orderNumber)).toMatch(
      /^QP-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
    );
  });
});
