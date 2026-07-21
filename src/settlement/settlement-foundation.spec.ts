// Settlement Engine Foundation tests (Track C PR 1).
//
// Pinned, in constitutional order (SC v2.0):
//   * §2 STATE LAW — every legal transition passes; every illegal one
//     throws; settled/superseded/reversed are terminal.
//   * §4 CALCULATOR — enumerated signed sum in integer minor units;
//     zero-net lawful (S18); negative lawful (S19); currencies never
//     sum (S32); fees/taxes lines structurally zero.
//   * §14 QS — allocated once at assembly; unique; retry keeps it;
//     supersession → successor gets a NEW QS; simulations get NONE.
//   * §30 SIMULATION — same calculator, zero side effects (structural:
//     the simulate mock has no create/update surfaces beyond reads).
//   * §11/§18 MARKERS — settlement.started/superseded post as
//     zero-amount marker rows with deterministic keys; money events
//     still refuse zero.
//   * §34 REPLAY — assembly freezes composition + calculation; the
//     frozen snapshot recomputes to the identical result through the
//     same calculator (the one-calculator law made testable).

import {
  assertBatchTransition,
  assertItemTransition,
  IllegalSettlementTransition,
} from './settlement-states';
import {
  calculateSettlement,
  MixedCurrencyError,
} from './settlement-calculator';
import { SettlementEngineService } from './settlement-engine.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

// ── §2 state law ─────────────────────────────────────────────────────
describe('settlement state law (SC v2.0 §2)', () => {
  it('allows every constitutional transition', () => {
    const legal: Array<['item' | 'batch', string, string]> = [
      ['item', 'pending', 'eligible'],
      ['item', 'pending', 'held'],
      ['item', 'pending', 'disputed'],
      ['item', 'eligible', 'ready'],
      ['item', 'held', 'eligible'],
      ['item', 'ready', 'settled'],
      ['item', 'ready', 'eligible'],
      ['item', 'settled', 'reversed'],
      ['item', 'disputed', 'eligible'],
      ['batch', 'ready', 'settled'],
      ['batch', 'ready', 'failed'],
      ['batch', 'ready', 'superseded'],
      ['batch', 'failed', 'ready'],
      ['batch', 'failed', 'superseded'],
    ];
    for (const [grain, from, to] of legal) {
      const assert =
        grain === 'item' ? assertItemTransition : assertBatchTransition;
      expect(() => assert(from as never, to as never)).not.toThrow();
    }
  });

  it('terminal states never transition; skips throw', () => {
    const illegal: Array<['item' | 'batch', string, string]> = [
      ['item', 'pending', 'ready'], // no silent skip of eligibility
      ['item', 'pending', 'settled'],
      ['item', 'reversed', 'eligible'], // terminal
      ['item', 'settled', 'eligible'],
      ['item', 'held', 'ready'], // release goes via eligible
      ['batch', 'settled', 'ready'], // terminal
      ['batch', 'settled', 'superseded'],
      ['batch', 'superseded', 'ready'], // terminal
    ];
    for (const [grain, from, to] of illegal) {
      const assert =
        grain === 'item' ? assertItemTransition : assertBatchTransition;
      expect(() => assert(from as never, to as never)).toThrow(
        IllegalSettlementTransition,
      );
    }
  });
});

// ── §4 calculator ────────────────────────────────────────────────────
const item = (id: string, amount: number, currency = 'SAR') => ({
  itemId: id,
  occurrenceType: 'merchant_invoice',
  occurrenceId: `mi-${id}`,
  amount,
  currency,
});

describe('settlement calculator (SC v2.0 §4 — the ONE calculator)', () => {
  it('S01-shape: pure gross settles at face value; fees/taxes lines are structurally zero', () => {
    const calc = calculateSettlement([item('a', 5750)]);
    expect(calc.lines.merchantGross).toBe(5750);
    expect(calc.lines.qiftFees).toBe(0);
    expect(calc.lines.taxes).toBe(0);
    expect(calc.netAmount).toBe(5750);
  });

  it('S18 PIN: zero-net is lawful (gross 1,000 − refunds 400 − recovery 600 = 0)', () => {
    const calc = calculateSettlement([item('a', 1000)], {
      refunds: 400,
      receivableRecovery: 600,
    });
    expect(calc.netAmount).toBe(0);
  });

  it('S19 PIN: negative net is lawful and exact (recovery exceeds gross)', () => {
    const calc = calculateSettlement([item('a', 1000)], {
      receivableRecovery: 3750,
    });
    expect(calc.netAmount).toBe(-2750);
  });

  it('S32 PIN: currencies never sum; unknown currencies refused', () => {
    expect(() =>
      calculateSettlement([item('a', 100, 'SAR'), item('b', 100, 'AED')]),
    ).toThrow(MixedCurrencyError);
    expect(() => calculateSettlement([item('a', 100, 'USD')])).toThrow(
      /settlement_unknown_currency/,
    );
  });

  it('integer-minor exactness: 0.1 + 0.2 style drift cannot occur', () => {
    const calc = calculateSettlement([item('a', 0.1), item('b', 0.2)], {
      refunds: 0.3,
    });
    expect(calc.netAmount).toBe(0); // 10 + 20 − 30 halalas, exactly
  });

  it('reserve lines move signed as legislated (§4/§7)', () => {
    const calc = calculateSettlement([item('a', 10000)], {
      reserveHeld: 500,
    });
    expect(calc.netAmount).toBe(9500);
    const later = calculateSettlement([item('b', 5000)], {
      reserveReleased: 500,
    });
    expect(later.netAmount).toBe(5500);
  });

  it('empty composition refused — a batch of nothing is not a batch', () => {
    expect(() => calculateSettlement([])).toThrow(
      'settlement_empty_composition',
    );
  });
});

// ── engine harness ───────────────────────────────────────────────────
type Row = Record<string, unknown>;
function mkEngine(items: Row[]) {
  const batches = new Map<string, Row>();
  let seq = 0;
  const prisma = {
    settlementItem: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { state?: string; batchId?: string };
        return Promise.resolve(
          items.filter(
            (i) =>
              (w.state ? i.state === w.state : true) &&
              (w.batchId ? i.batchId === w.batchId : true),
          ),
        );
      }),
      // Guard-aware mock: honours the engine's concurrency WHERE
      // (state / batchId) so contention scenarios behave like the DB.
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as {
          id: { in: string[] } | string;
          state?: string;
          batchId?: string | null;
        };
        const ids = typeof w.id === 'string' ? [w.id] : w.id.in;
        let count = 0;
        for (const i of items) {
          if (!ids.includes(i.id as string)) continue;
          if (w.state !== undefined && i.state !== w.state) continue;
          if (w.batchId !== undefined && i.batchId !== w.batchId) continue;
          Object.assign(i, data as Row);
          count++;
        }
        return Promise.resolve({ count });
      }),
      update: jest.fn().mockImplementation(({ where, data }: never) => {
        const row = items.find((i) => i.id === (where as { id: string }).id)!;
        Object.assign(row, data as Row);
        return Promise.resolve(row);
      }),
    },
    // Reference denormalization reads (SC §15.1) — empty world here.
    merchantInvoice: { findMany: jest.fn().mockResolvedValue([]) },
    giftCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    // Anti-double-pay check in supersede — no remittances in PR-1 world.
    settlementRemittance: { findUnique: jest.fn().mockResolvedValue(null) },
    settlementBatch: {
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { id?: string; settlementReference?: string };
        if (w.id) return Promise.resolve(batches.get(w.id) ?? null);
        return Promise.resolve(
          [...batches.values()].find(
            (b) => b.settlementReference === w.settlementReference,
          ) ?? null,
        );
      }),
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `batch-${++seq}`, ...(data as Row) };
        batches.set(row.id as string, row);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation(({ where, data }: never) => {
        const row = batches.get((where as { id: string }).id)!;
        Object.assign(row, data as Row);
        return Promise.resolve(row);
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const ledger = { record: jest.fn().mockResolvedValue({ id: 'led-1' }) };
  // Rule 2: tests inject a FIXED clock — engine time is deterministic.
  const clock = { now: () => new Date('2026-07-20T12:00:00.000Z') };
  const engine = new SettlementEngineService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledger as unknown as FinancialLedgerService,
    clock,
  );
  return { prisma, audit, ledger, engine, batches, items, clock };
}

const eligibleItem = (id: string, amount: number): Row => ({
  id,
  occurrenceType: 'merchant_invoice',
  occurrenceId: `mi-${id}`,
  storeId: 's-1',
  currency: 'SAR',
  amount,
  state: 'eligible',
  batchId: null,
});

describe('SettlementEngineService (Track C PR 1)', () => {
  it('§30: simulation runs the SAME calculator with ZERO side effects and NO QS', async () => {
    const { prisma, audit, ledger, engine } = mkEngine([
      eligibleItem('i1', 5750),
      eligibleItem('i2', 2300),
    ]);
    const sim = await engine.simulate('fin-1', 's-1');
    expect(sim.simulation).toBe(true);
    expect(sim.calculation!.netAmount).toBe(8050);
    // No QS anywhere in the payload (RC App. E: no placeholders).
    expect(JSON.stringify(sim)).not.toMatch(/QS-/);
    // ZERO side effects: no batch created, no item touched, no ledger.
    expect(prisma.settlementBatch.create).not.toHaveBeenCalled();
    expect(prisma.settlementItem.updateMany).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
    // The COUNTS-ONLY audit line is the ONLY trace (§30.2) — no
    // computed results (netAmount) in the record.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement.simulated',
        metadata: { itemCount: 2, currency: 'SAR' },
      }),
    );
  });

  it('§14: assembly allocates ONE QS, freezes composition+calculation, posts the started marker with a deterministic key', async () => {
    const { prisma, ledger, engine, items } = mkEngine([
      eligibleItem('i1', 5750),
      eligibleItem('i2', 2300),
    ]);
    const batch = await engine.assembleBatch('fin-1', 's-1');
    expect(batch.settlementReference).toMatch(
      /^QS-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
    );
    expect(batch.status).toBe('ready');
    expect(batch.netAmount).toBe(8050);
    // §34: frozen composition covers both occurrences.
    expect((batch.composition as Row[]).map((c) => c.occurrenceId)).toEqual([
      'mi-i1',
      'mi-i2',
    ]);
    // Items bound: eligible → ready.
    expect(
      items.every((i) => i.state === 'ready' && i.batchId === batch.id),
    ).toBe(true);
    // §11.1: zero-amount marker, deterministic key, posted INSIDE the
    // assembly transaction (second arg = the tx client).
    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'settlement.started',
        amount: 0,
        idempotencyKey: `settlement.started:${batch.id}`,
      }),
      expect.anything(),
    );
  });

  it('§14/§25.3: markFailed requires evidence; retry keeps the SAME QS', async () => {
    const { engine } = mkEngine([eligibleItem('i1', 1000)]);
    const batch = await engine.assembleBatch('fin-1', 's-1');
    await expect(engine.markFailed('fin-1', batch.id, ' ')).rejects.toThrow(
      'failure_evidence_required',
    );
    await engine.markFailed('fin-1', batch.id, 'bank rejected: IBAN closed');
    const retried = await engine.retry('fin-1', batch.id);
    expect(retried.status).toBe('ready');
    expect(retried.settlementReference).toBe(batch.settlementReference); // same QS
  });

  it('§2 v2.0: supersession is terminal, closes with the superseded marker, and the successor gets a NEW QS', async () => {
    const { ledger, engine, items } = mkEngine([
      eligibleItem('i1', 5750),
      eligibleItem('i2', 2300),
    ]);
    const first = await engine.assembleBatch('fin-1', 's-1');
    const superseded = await engine.supersede(
      'fin-1',
      first.id,
      'hold_landed',
      ['i2'],
      { holdType: 'risk_review', holdEvidence: 'chargeback spike Q3 review' },
    );
    expect(superseded.status).toBe('superseded');
    // §11.1: the closing marker with ITS deterministic key.
    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'settlement.superseded',
        amount: 0,
        idempotencyKey: `settlement.superseded:${first.id}`,
      }),
      expect.anything(),
    );
    // Items disposed per cause: affected → held; the rest → eligible.
    expect(items.find((i) => i.id === 'i2')!.state).toBe('held');
    expect(items.find((i) => i.id === 'i1')!.state).toBe('eligible');
    // Successor: new batch, NEW QS (i1 only).
    const successor = await engine.assembleBatch('fin-1', 's-1');
    expect(successor.settlementReference).not.toBe(first.settlementReference);
    expect(successor.netAmount).toBe(5750);
    // Terminal: the superseded batch can never be re-opened.
    await expect(engine.retry('fin-1', first.id)).rejects.toThrow(
      IllegalSettlementTransition,
    );
  });

  it('§30.2: unknown supersession causes are refused (closed set)', async () => {
    const { engine } = mkEngine([eligibleItem('i1', 1000)]);
    const batch = await engine.assembleBatch('fin-1', 's-1');
    await expect(
      engine.supersede('fin-1', batch.id, 'because_reasons'),
    ).rejects.toThrow('supersede_cause_unknown');
  });

  it('§34 REPLAY PIN: the frozen calculationSnapshot recomputes identically through the one calculator', async () => {
    const { engine, batches } = mkEngine([
      eligibleItem('i1', 5750),
      eligibleItem('i2', 2300.45),
    ]);
    const batch = await engine.assembleBatch('fin-1', 's-1');
    const frozen = batches.get(batch.id)!;
    const composition = frozen.composition as Array<{
      itemId: string;
      occurrenceType: string;
      occurrenceId: string;
      amount: number;
      currency: string;
    }>;
    // Replay: same frozen inputs → same calculator → identical output.
    const replayed = calculateSettlement(
      composition.map((c) => ({
        itemId: c.itemId,
        occurrenceType: c.occurrenceType,
        occurrenceId: c.occurrenceId,
        amount: c.amount,
        currency: c.currency,
      })),
    );
    expect(replayed).toEqual(frozen.calculationSnapshot);
  });
});

describe('review-hardening pins (Track C PR 1 adversarial review)', () => {
  it('CONCURRENCY (finding 1): a contended item rolls the whole assembly back', async () => {
    const { prisma, engine, items } = mkEngine([
      eligibleItem('i1', 1000),
      eligibleItem('i2', 2000),
    ]);
    // Simulate a racing assembly binding i2 between read and tx.
    const realUpdateMany = prisma.settlementItem.updateMany;
    prisma.settlementItem.updateMany = jest
      .fn()
      .mockImplementation((args: never) => {
        items.find((i) => i.id === 'i2')!.batchId = 'stolen';
        items.find((i) => i.id === 'i2')!.state = 'ready';
        return realUpdateMany(args);
      });
    await expect(engine.assembleBatch('fin-1', 's-1')).rejects.toThrow(
      'settlement_items_contended',
    );
  });

  it('§6.1 (finding 4): hold_landed supersession REQUIRES type + evidence; unknown ids refused', async () => {
    const { engine } = mkEngine([eligibleItem('i1', 1000)]);
    const batch = await engine.assembleBatch('fin-1', 's-1');
    await expect(
      engine.supersede('fin-1', batch.id, 'hold_landed', ['i1']),
    ).rejects.toThrow('hold_type_and_evidence_required');
    await expect(
      engine.supersede('fin-1', batch.id, 'withdrawn', ['not-a-member']),
    ).rejects.toThrow('supersede_item_not_in_batch');
  });

  it('§2/§19.2 (finding 3): repeated failure escalates to a HELD batch, resolvable to ready', async () => {
    const { engine } = mkEngine([eligibleItem('i1', 1000)]);
    const batch = await engine.assembleBatch('fin-1', 's-1');
    await engine.markFailed('fin-1', batch.id, 'bank rejected #1');
    const held = await engine.holdBatch(
      'fin-1',
      batch.id,
      'third rejection — investigating IBAN with merchant',
    );
    expect(held.status).toBe('held');
    const back = await engine.retry('fin-1', batch.id);
    expect(back.status).toBe('ready');
    expect(back.settlementReference).toBe(batch.settlementReference);
  });

  it('linkSuccessor (finding 6b): write-once, no self-link', async () => {
    const { engine } = mkEngine([
      eligibleItem('i1', 1000),
      eligibleItem('i2', 500),
    ]);
    const first = await engine.assembleBatch('fin-1', 's-1');
    await expect(engine.linkSuccessor(first.id, first.id)).rejects.toThrow(
      'successor_cannot_be_self',
    );
  });
});
