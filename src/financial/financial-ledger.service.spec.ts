import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FinancialLedgerService,
  sanitizeLedgerMetadata,
  type RecordLedgerInput,
} from './financial-ledger.service';

// PR 2 — append-only FinancialLedgerEntry substrate.

function buildService() {
  const financialLedgerEntry = {
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve({
          id: 'ledger-1',
          createdAt: new Date(0),
          ...(data as object),
        }),
      ),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    // Present on the mock ONLY so the test can prove the service never
    // calls them. The real code references neither.
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = { financialLedgerEntry };
  const service = new FinancialLedgerService(prisma as never);
  return { service, financialLedgerEntry };
}

function validInput(
  overrides: Partial<RecordLedgerInput> = {},
): RecordLedgerInput {
  return {
    eventType: 'order.captured',
    reasonCode: 'ORDER_CAPTURE',
    actorType: 'system',
    amount: 515,
    currency: 'sar',
    direction: 'credit',
    orderId: 'order-1',
    storeId: 'store-1',
    ...overrides,
  };
}

describe('FinancialLedgerService', () => {
  describe('record — entries can be created', () => {
    it('persists a valid entry with normalised currency and returns it', async () => {
      const { service, financialLedgerEntry } = buildService();
      const entry = await service.record(validInput());
      expect(financialLedgerEntry.create).toHaveBeenCalledTimes(1);
      const data = financialLedgerEntry.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        eventType: 'order.captured',
        reasonCode: 'ORDER_CAPTURE',
        actorType: 'system',
        amount: 515,
        currency: 'SAR', // normalised to uppercase
        direction: 'credit',
        orderId: 'order-1',
        storeId: 'store-1',
      });
      expect(entry).toMatchObject({ id: 'ledger-1' });
    });

    it('defaults optional correlation ids + actorId to null', async () => {
      const { service, financialLedgerEntry } = buildService();
      await service.record(validInput({ storeId: undefined }));
      const data = financialLedgerEntry.create.mock.calls[0][0].data;
      expect(data.actorId).toBeNull();
      expect(data.paymentId).toBeNull();
      expect(data.campaignId).toBeNull();
      expect(data.orgId).toBeNull();
      expect(data.storeId).toBeNull();
    });
  });

  describe('append-only — no update/delete path exists', () => {
    it('exposes no mutation methods on the service', () => {
      const { service } = buildService();
      for (const method of [
        'update',
        'updateMany',
        'delete',
        'deleteMany',
        'remove',
        'edit',
        'patch',
      ]) {
        expect(
          (service as unknown as Record<string, unknown>)[method],
        ).toBeUndefined();
      }
    });

    it('never calls prisma update/delete when recording', async () => {
      const { service, financialLedgerEntry } = buildService();
      await service.record(validInput());
      expect(financialLedgerEntry.update).not.toHaveBeenCalled();
      expect(financialLedgerEntry.updateMany).not.toHaveBeenCalled();
      expect(financialLedgerEntry.delete).not.toHaveBeenCalled();
      expect(financialLedgerEntry.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('metadata — never carries recipient address / PII', () => {
    it('strips sensitive address / phone / geo keys before persisting', async () => {
      const { service, financialLedgerEntry } = buildService();
      await service.record(
        validInput({
          metadata: {
            note: 'campaign wave 1',
            street: '123 King Fahd Rd',
            buildingNumber: '7',
            city: 'Riyadh',
            recipientPhone: '+966500000000',
            coordinates: { lat: 24.7, lng: 46.6 },
            nested: { line1: 'secret', keep: 'ok' },
          },
        }),
      );
      const data = financialLedgerEntry.create.mock.calls[0][0].data;
      const meta = data.metadata as Record<string, unknown>;
      expect(meta.note).toBe('campaign wave 1');
      expect((meta.nested as Record<string, unknown>).keep).toBe('ok');
      // Every sensitive key gone, at every level.
      const flat = JSON.stringify(meta).toLowerCase();
      for (const banned of [
        'street',
        'buildingnumber',
        'city',
        'recipientphone',
        'coordinates',
        'lat',
        'line1',
        '123 king fahd',
        '+96650',
      ]) {
        expect(flat).not.toContain(banned.toLowerCase());
      }
    });

    it('sanitizeLedgerMetadata returns null for empty metadata; record stores JsonNull', async () => {
      expect(sanitizeLedgerMetadata(null)).toBeNull();
      expect(sanitizeLedgerMetadata(undefined)).toBeNull();
      const { service, financialLedgerEntry } = buildService();
      await service.record(validInput({ metadata: undefined }));
      expect(financialLedgerEntry.create.mock.calls[0][0].data.metadata).toBe(
        Prisma.JsonNull,
      );
    });
  });

  describe('count / query friendly', () => {
    it('queries indexed columns for order/store/campaign and reasonCode count', async () => {
      const { service, financialLedgerEntry } = buildService();
      await service.findByOrder('order-9');
      await service.findByStore('store-9');
      await service.findByCampaign('camp-9');
      await service.countByReasonCode('QIFT_SERVICE_FEE');
      expect(financialLedgerEntry.findMany).toHaveBeenNthCalledWith(1, {
        where: { orderId: 'order-9' },
        orderBy: { createdAt: 'asc' },
      });
      expect(financialLedgerEntry.findMany).toHaveBeenNthCalledWith(2, {
        where: { storeId: 'store-9' },
        orderBy: { createdAt: 'asc' },
      });
      expect(financialLedgerEntry.findMany).toHaveBeenNthCalledWith(3, {
        where: { campaignId: 'camp-9' },
        orderBy: { createdAt: 'asc' },
      });
      expect(financialLedgerEntry.count).toHaveBeenCalledWith({
        where: { reasonCode: 'QIFT_SERVICE_FEE' },
      });
    });
  });

  describe('validation — amount / currency / direction', () => {
    it('rejects a non-positive or non-finite amount', async () => {
      const { service } = buildService();
      await expect(
        service.record(validInput({ amount: 0 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.record(validInput({ amount: -5 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.record(validInput({ amount: Number.NaN })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty currency', async () => {
      const { service } = buildService();
      await expect(
        service.record(validInput({ currency: '  ' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a direction other than credit/debit', async () => {
      const { service } = buildService();
      await expect(
        service.record(validInput({ direction: 'sideways' as never })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects missing eventType / reasonCode / actorType', async () => {
      const { service } = buildService();
      await expect(
        service.record(validInput({ eventType: '' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.record(validInput({ reasonCode: '  ' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not persist anything when validation fails', async () => {
      const { service, financialLedgerEntry } = buildService();
      await expect(
        service.record(validInput({ amount: -1 })),
      ).rejects.toThrow();
      expect(financialLedgerEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('idempotencyKey (FIN-4)', () => {
    it('persists the deterministic key on the created row', async () => {
      const { service, financialLedgerEntry } = buildService();
      await service.record(
        validInput({ idempotencyKey: 'order.paid:order-1' }),
      );
      const data = financialLedgerEntry.create.mock.calls[0][0].data as {
        idempotencyKey: string | null;
      };
      expect(data.idempotencyKey).toBe('order.paid:order-1');
    });

    it('a duplicate key does NOT duplicate — returns the existing row', async () => {
      const { service, financialLedgerEntry } = buildService();
      financialLedgerEntry.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      const original = {
        id: 'led-original',
        idempotencyKey: 'order.paid:order-1',
      };
      financialLedgerEntry.findUnique.mockResolvedValueOnce(original);
      const out = await service.record(
        validInput({ idempotencyKey: 'order.paid:order-1' }),
      );
      expect(out).toBe(original); // the FIRST posting, untouched
      expect(financialLedgerEntry.create).toHaveBeenCalledTimes(1);
      expect(financialLedgerEntry.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: 'order.paid:order-1' },
      });
    });

    it('a P2002 WITHOUT a key still propagates (legacy caller contract)', async () => {
      const { service, financialLedgerEntry } = buildService();
      financialLedgerEntry.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      await expect(service.record(validInput())).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('a blank key is stored as null (never an empty-string unique)', async () => {
      const { service, financialLedgerEntry } = buildService();
      await service.record(validInput({ idempotencyKey: '  ' }));
      const data = financialLedgerEntry.create.mock.calls[0][0].data as {
        idempotencyKey: string | null;
      };
      expect(data.idempotencyKey).toBeNull();
    });

    it('findByIdempotencyKey reads the unique row', async () => {
      const { service, financialLedgerEntry } = buildService();
      financialLedgerEntry.findUnique.mockResolvedValueOnce({ id: 'led-1' });
      const out = await service.findByIdempotencyKey('k');
      expect(out).toEqual({ id: 'led-1' });
      expect(financialLedgerEntry.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: 'k' },
      });
    });
  });
});
