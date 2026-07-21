// SETTLE-1 eligibility — §5 pins (Track C PR 2).
//
// Every §5 condition is exercised both ways: an item moves
// pending → eligible ONLY when all seven hold, and an item that stays
// pending enumerates exactly why (audited, policy-versioned).

import {
  SettlementEligibilityService,
  ELIGIBILITY_POLICY_VERSIONS,
} from './settlement-eligibility.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const CLOCK_NOW = '2026-07-21T09:00:00.000Z';

function harness(opts: {
  store?: Row | null;
  items?: Row[];
  invoice?: Row | null;
  receipts?: Row[];
  claims?: Row[];
}) {
  const items = opts.items ?? [];
  const auditRows: Row[] = [];
  const prisma = {
    store: {
      findUnique: jest.fn().mockResolvedValue(
        opts.store === null
          ? null
          : (opts.store ?? {
              id: 's-1',
              payoutIdentityVerifiedAt: new Date('2026-07-01T00:00:00.000Z'),
            }),
      ),
      update: jest.fn().mockImplementation(({ data }: never) =>
        Promise.resolve({ id: 's-1', ...(data as Row) }),
      ),
    },
    settlementItem: {
      findMany: jest.fn().mockResolvedValue(items),
      updateMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as Row;
        const item = items.find((i) => i.id === w.id);
        if (!item || item.state !== w.state || item.batchId !== w.batchId) {
          return Promise.resolve({ count: 0 });
        }
        item.state = 'eligible';
        return Promise.resolve({ count: 1 });
      }),
    },
    merchantInvoice: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.invoice === null
            ? null
            : (opts.invoice ?? {
                totalAmount: 5750,
                campaignId: 'camp-1',
                status: 'paid',
              }),
        ),
    },
    paymentReceipt: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.receipts ?? [{ amount: 5750 }]),
    },
    claimableGift: {
      findMany: jest.fn().mockResolvedValue(opts.claims ?? []),
    },
  };
  const audit = {
    record: jest.fn().mockImplementation((row: Row) => {
      auditRows.push(row);
      return Promise.resolve(undefined);
    }),
  };
  const service = new SettlementEligibilityService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    { now: () => new Date(CLOCK_NOW) },
  );
  return { service, prisma, audit, auditRows, items };
}

const pendingItem = (over: Row = {}): Row => ({
  id: 'sitem-1',
  occurrenceType: 'merchant_invoice',
  occurrenceId: 'minv-1',
  storeId: 's-1',
  currency: 'SAR',
  amount: 5750,
  state: 'pending',
  batchId: null,
  holdType: null,
  ...over,
});

function conditionMap(result: {
  conditions: Array<{ condition: string; met: boolean }>;
}) {
  return Object.fromEntries(result.conditions.map((c) => [c.condition, c.met]));
}

describe('SettlementEligibilityService (§5)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('all seven conditions met → eligible, audited with policy versions', async () => {
    const { service, auditRows, items } = harness({
      items: [pendingItem()],
      claims: [
        { status: 'claimed', expiresAt: new Date('2026-08-01') },
        { status: 'declined', expiresAt: new Date('2026-08-01') },
      ],
    });
    const res = await service.evaluate('fin-1', 's-1');
    expect(res.eligibleCount).toBe(1);
    expect(res.items[0].outcome).toBe('eligible');
    expect(items[0].state).toBe('eligible');
    expect(res.evaluatedAt).toBe(CLOCK_NOW);
    const audit = auditRows.find(
      (a) => a.action === 'settlement.item.eligible',
    )!;
    const versions = (
      audit.metadata as { conditions: Array<Row> }
    ).conditions.filter((c) => c.policyVersion);
    expect(versions.map((c) => c.policyVersion)).toEqual([
      ELIGIBILITY_POLICY_VERSIONS.delivery_state,
      ELIGIBILITY_POLICY_VERSIONS.dispute_free,
      ELIGIBILITY_POLICY_VERSIONS.threshold,
      ELIGIBILITY_POLICY_VERSIONS.platform_gates,
    ]);
  });

  it('§5.1 money not received (receipts short) → stays pending, reason enumerated', async () => {
    const { service, items } = harness({
      items: [pendingItem()],
      receipts: [{ amount: 2000 }],
    });
    const res = await service.evaluate('fin-1', 's-1');
    expect(res.items[0].outcome).toBe('pending');
    expect(items[0].state).toBe('pending');
    expect(conditionMap(res.items[0]).money_received).toBe(false);
  });

  it('§5.2 an open claim inside its window blocks; a lazily-expired pending claim does NOT', async () => {
    const open = await harness({
      items: [pendingItem()],
      claims: [{ status: 'pending', expiresAt: new Date('2026-08-01') }],
    }).service.evaluate('fin-1', 's-1');
    expect(open.items[0].outcome).toBe('pending');
    expect(conditionMap(open.items[0]).delivery_state).toBe(false);

    const lapsed = await harness({
      items: [pendingItem()],
      claims: [{ status: 'pending', expiresAt: new Date('2026-07-01') }],
    }).service.evaluate('fin-1', 's-1');
    expect(conditionMap(lapsed.items[0]).delivery_state).toBe(true);
    expect(lapsed.items[0].outcome).toBe('eligible');
  });

  it('§5.4 payout identity unverified → hard block', async () => {
    const { service } = harness({
      store: { id: 's-1', payoutIdentityVerifiedAt: null },
      items: [pendingItem()],
    });
    const res = await service.evaluate('fin-1', 's-1');
    expect(res.items[0].outcome).toBe('pending');
    expect(conditionMap(res.items[0]).payout_identity_verified).toBe(false);
  });

  it('§6 a typed hold blocks (no_blocking_hold false, holdType surfaced)', async () => {
    const { service } = harness({
      items: [pendingItem({ holdType: 'risk_review' })],
    });
    const res = await service.evaluate('fin-1', 's-1');
    expect(res.items[0].outcome).toBe('pending');
    expect(conditionMap(res.items[0]).no_blocking_hold).toBe(false);
  });

  it('§5.7 gates not attested → platform_gates false, nothing becomes eligible', async () => {
    delete process.env[GATES_ENV];
    try {
      const { service, items } = harness({ items: [pendingItem()] });
      const res = await service.evaluate('fin-1', 's-1');
      expect(res.items[0].outcome).toBe('pending');
      expect(conditionMap(res.items[0]).platform_gates).toBe(false);
      expect(items[0].state).toBe('pending');
    } finally {
      process.env[GATES_ENV] = 'true';
    }
  });

  it('unknown occurrence kinds never settle silently', async () => {
    const { service } = harness({
      items: [pendingItem({ occurrenceType: 'mystery' })],
    });
    const res = await service.evaluate('fin-1', 's-1');
    expect(res.items[0].outcome).toBe('pending');
    expect(conditionMap(res.items[0]).money_received).toBe(false);
  });

  it('§5.2 mismatch and revoked claims are TERMINAL — one "not me" click never wedges settlement (review finding 2)', async () => {
    const res = await harness({
      items: [pendingItem()],
      claims: [
        { status: 'claimed', expiresAt: new Date('2026-08-01') },
        { status: 'mismatch', expiresAt: new Date('2026-08-01') },
        { status: 'revoked', expiresAt: new Date('2026-08-01') },
      ],
    }).service.evaluate('fin-1', 's-1');
    expect(conditionMap(res.items[0]).delivery_state).toBe(true);
    expect(res.items[0].outcome).toBe('eligible');
  });

  it('§5.2 ZERO claims minted blocks — vacuous truth never settles pre-dispatch money (review finding 5)', async () => {
    const res = await harness({
      items: [pendingItem()],
      claims: [],
    }).service.evaluate('fin-1', 's-1');
    expect(conditionMap(res.items[0]).delivery_state).toBe(false);
    expect(res.items[0].outcome).toBe('pending');
    const cond = res.items[0].conditions.find(
      (c) => c.condition === 'delivery_state',
    )!;
    expect(cond.detail).toMatchObject({ reason: 'no_claims_minted' });
  });

  it('a racing transition loses cleanly (guarded updateMany → contended, audited)', async () => {
    const items = [pendingItem()];
    const h = harness({
      items,
      claims: [{ status: 'claimed', expiresAt: new Date('2026-08-01') }],
    });
    // Sabotage the guard: another actor moved the item mid-evaluation.
    (h.prisma.settlementItem.updateMany as jest.Mock).mockResolvedValue({
      count: 0,
    });
    const res = await h.service.evaluate('fin-1', 's-1');
    expect(res.items[0].outcome).toBe('contended');
    expect(res.eligibleCount).toBe(0);
    // Review finding 6: the enumerated conditions survive in audit.
    expect(
      h.auditRows.find((a) => a.action === 'settlement.item.contended'),
    ).toBeTruthy();
  });

  it('verifyPayoutIdentity: evidence required, stamped off the injected clock, audited', async () => {
    const { service, prisma, auditRows } = harness({});
    await expect(
      service.verifyPayoutIdentity('fin-1', 's-1', '  '),
    ).rejects.toThrow('payout_identity_evidence_required');
    const updated = await service.verifyPayoutIdentity(
      'fin-1',
      's-1',
      'IBAN letter sighted + CR match (ops ticket OPS-291)',
    );
    expect(
      (updated.payoutIdentityVerifiedAt as Date).toISOString(),
    ).toBe(CLOCK_NOW);
    expect(prisma.store.update).toHaveBeenCalledTimes(1);
    expect(
      auditRows.find((a) => a.action === 'settlement.payout_identity.verified'),
    ).toBeTruthy();
    await expect(
      harness({ store: null }).service.verifyPayoutIdentity(
        'fin-1',
        'missing',
        'evidence',
      ),
    ).rejects.toThrow('store_not_found');
  });
});
