// Closed-beta sandbox-flag inheritance on the Order → Gift transition.
//
// Scope: PaymentsService.confirmMock takes an Order with isSandbox
// already set (resolved at Order create-time) and forwards the
// boolean verbatim to GiftsService.create. The Gift inherits the
// Order's classification — no re-resolution, no flag flipping.
// This spec mocks PrismaService + GiftsService and asserts the
// exact isSandbox value flowing through the gifts.create call.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed in tests; production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { GiftsService } from '../gifts/gifts.service';

const VIEWER_ID = 'user_sender';

function fakeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order_1',
    userId: VIEWER_ID,
    giftId: null,
    receiverUsername: 'reem',
    productName: 'Eau de Parfum',
    storeName: 'House of Oud',
    productId: null,
    storeId: null,
    productPrice: 100,
    serviceFee: 10,
    deliveryFee: 5,
    totalAmount: 115,
    currency: 'SAR',
    country: 'SA',
    paymentProvider: 'mada',
    message: null,
    mediaUrl: null,
    mediaType: null,
    isSurprise: false,
    isAnonymous: false,
    isSandbox: false,
    occasionId: null,
    status: 'pending',
    createdAt: new Date(),
    payment: null,
    gift: null,
    ...overrides,
  };
}

function buildPrismaMock(initial: Record<string, unknown>) {
  // First findUnique returns the order in 'pending' state; after the
  // service's updateMany call we still return the same row on any
  // subsequent findUnique (the test scenarios don't exercise the
  // "second caller racing" path). The transaction's tx.order.update
  // returns the final paid order shape.
  const orderFindUnique = jest.fn().mockResolvedValue(initial);
  const orderUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const orderUpdate = jest
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...initial,
        ...data,
      }),
    );
  const paymentUpsert = jest.fn().mockResolvedValue({});

  return {
    order: {
      findUnique: orderFindUnique,
      updateMany: orderUpdateMany,
      update: orderUpdate,
    },
    payment: { upsert: paymentUpsert },
    $transaction: jest
      .fn()
      .mockImplementation(
        async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
          cb({
            payment: { upsert: paymentUpsert },
            order: { update: orderUpdate },
          }),
      ),
  };
}

describe('PaymentsService.confirmMock — sandbox flag inheritance', () => {
  let service: PaymentsService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let gifts: { create: jest.Mock };

  async function bootWithOrder(initial: Record<string, unknown>) {
    prisma = buildPrismaMock(initial);
    gifts = {
      create: jest.fn().mockResolvedValue({
        gift: { id: 'gift_1' },
        replayed: false,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: GiftsService, useValue: gifts },
      ],
    }).compile();
    service = module.get<PaymentsService>(PaymentsService);
  }

  it('forwards isSandbox=true verbatim when the Order is sandbox', async () => {
    // The load-bearing test: a sandbox Order must produce a sandbox
    // Gift. The flag must transit the gateway hop and end up as
    // body.isSandbox on the GiftsService.create call.
    await bootWithOrder(fakeOrder({ isSandbox: true }));
    await service.confirmMock('order_1', VIEWER_ID);

    expect(gifts.create).toHaveBeenCalledTimes(1);
    const [createBody] = gifts.create.mock.calls[0];
    expect(createBody.isSandbox).toBe(true);
  });

  it('forwards isSandbox=false verbatim when the Order is live', async () => {
    // Reciprocal property: a live Order must produce a live Gift.
    // No "everything-becomes-sandbox" leak from the closed-beta
    // codepath into post-beta production flows.
    await bootWithOrder(fakeOrder({ isSandbox: false }));
    await service.confirmMock('order_1', VIEWER_ID);

    const [createBody] = gifts.create.mock.calls[0];
    expect(createBody.isSandbox).toBe(false);
  });

  it('passes a boolean (never undefined) to GiftsService.create', async () => {
    // GiftsService.create accepts undefined and resolves via env.
    // PaymentsService should NEVER let it fall through to that
    // resolution — the Order row is the authority, and the Order
    // column is NOT NULL.
    await bootWithOrder(fakeOrder({ isSandbox: true }));
    await service.confirmMock('order_1', VIEWER_ID);

    const [createBody] = gifts.create.mock.calls[0];
    expect(typeof createBody.isSandbox).toBe('boolean');
  });
});
