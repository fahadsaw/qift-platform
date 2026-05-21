// Closed-beta sandbox flag wiring on OrdersService.create.
//
// Scope: every code path through OrdersService.create() must end
// up calling prisma.order.create with the correct isSandbox value
// per the sandbox-mode resolution matrix (see sandbox-mode.ts).
// We mock just enough collaborators to drive the happy path
// through to the create call; other order-validation concerns
// (payment provider, fast delivery, occasion attach) are out of
// scope here and pinned by other specs.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';

const SENDER_ID = 'user_sender';
const RECEIVER_ID = 'user_receiver';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    receiverUsername: 'reem',
    productName: 'Eau de Parfum',
    storeName: 'House of Oud',
    productPrice: 100,
    serviceFee: 10,
    deliveryFee: 5,
    totalAmount: 115,
    currency: 'SAR',
    country: 'SA',
    paymentProvider: 'mada',
    ...overrides,
  };
}

function buildPrismaMock() {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        // The sender lookup (.findUnique) returns the viewer's row.
        // qiftUsername must differ from the receiverUsername under
        // test so the self-send guard passes.
        qiftUsername: 'sender-handle',
      }),
      findFirst: jest.fn().mockResolvedValue({ id: RECEIVER_ID }),
    },
    address: {
      // Used by the GIFT_FLOW_DEBUG telemetry path only. Returning 1
      // keeps the path harmless when the debug flag is on.
      count: jest.fn().mockResolvedValue(1),
      // Default-address resolver: a single default address row is
      // returned so the no-default-address gate passes.
      findFirst: jest.fn().mockResolvedValue({
        id: 'addr_default',
        userId: RECEIVER_ID,
        isDefault: true,
        deletedAt: null,
      }),
    },
    order: {
      // Echo back the data we received so the test can assert the
      // exact isSandbox value the service computed.
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'order_1',
            ...data,
            payment: null,
            gift: null,
          }),
        ),
    },
  };
}

describe('OrdersService.create — sandbox flag propagation', () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  const originalEnv = process.env.SANDBOX_ONLY_MODE;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const usersStub = {
      // Only relied on by the fast-delivery branch; all tests below
      // omit isFastDelivery so this never gets called.
      canDeliverFast: jest.fn().mockResolvedValue(true),
    };
    const productsStub = {
      // No productId in the test inputs → checkAvailability returns
      // null and the storeId resolution falls through to body/null.
      checkAvailability: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: usersStub },
        { provide: ProductsService, useValue: productsStub },
      ],
    }).compile();
    service = module.get<OrdersService>(OrdersService);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SANDBOX_ONLY_MODE;
    } else {
      process.env.SANDBOX_ONLY_MODE = originalEnv;
    }
  });

  describe('SANDBOX_ONLY_MODE=true (closed-beta deploy)', () => {
    beforeEach(() => {
      process.env.SANDBOX_ONLY_MODE = 'true';
    });

    it('forces isSandbox=true when body omits the flag', async () => {
      // The load-bearing closed-beta invariant: a checkout that
      // forgets to set isSandbox cannot leak into a live order.
      await service.create(baseInput(), SENDER_ID);
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(true);
    });

    it('forces isSandbox=true even when body explicitly sets false', async () => {
      // Frontend cannot opt OUT of sandbox during closed beta.
      await service.create(baseInput({ isSandbox: false }), SENDER_ID);
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(true);
    });

    it('forces isSandbox=true when body explicitly sets true (no-op)', async () => {
      await service.create(baseInput({ isSandbox: true }), SENDER_ID);
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(true);
    });
  });

  describe('SANDBOX_ONLY_MODE=false (post-beta deploy)', () => {
    beforeEach(() => {
      process.env.SANDBOX_ONLY_MODE = 'false';
    });

    it('writes isSandbox=false when body omits the flag (production default)', async () => {
      await service.create(baseInput(), SENDER_ID);
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(false);
    });

    it('writes isSandbox=true when body explicitly opts in', async () => {
      // Per-request opt-in path: staging/QA can tag a single order
      // sandbox on an otherwise-live deploy.
      await service.create(baseInput({ isSandbox: true }), SENDER_ID);
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(true);
    });

    it('writes isSandbox=false when body explicitly opts out', async () => {
      await service.create(baseInput({ isSandbox: false }), SENDER_ID);
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(false);
    });
  });

  describe('SANDBOX_ONLY_MODE unset (production default)', () => {
    beforeEach(() => {
      delete process.env.SANDBOX_ONLY_MODE;
    });

    it('writes isSandbox=false by default — production cannot become sandbox by accident', async () => {
      // Critical safety property: an unset env var must NEVER
      // produce a sandbox order. Production deploys that haven't
      // explicitly set SANDBOX_ONLY_MODE=true must default to live.
      await service.create(baseInput(), SENDER_ID);
      const data = prisma.order.create.mock.calls[0][0].data;
      expect(data.isSandbox).toBe(false);
    });
  });
});
