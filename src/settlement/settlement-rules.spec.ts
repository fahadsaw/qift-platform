// PERMANENT SETTLEMENT IMPLEMENTATION RULES — pinned tests.
//
// Enacted by founder directive after PR 1 approval (Track C, 2026-07-21).
// These three rules are PERMANENT LAW for all settlement code, present
// and future. This spec is the tripwire: it fails the moment any code
// change violates a rule, anywhere in src/. Deleting or weakening a pin
// requires the same scrutiny as a constitutional amendment.
//
//   RULE 1 — All settlement calculations remain inside the Settlement
//            Engine. Controllers, routes and endpoints NEVER implement
//            financial calculations.
//   RULE 2 — The Settlement Engine never depends directly on Date.now()
//            or system time. Time enters ONLY through the injectable
//            SettlementClock (settlement-clock.ts), so §34 replay and
//            tests stay deterministic.
//   RULE 3 — A SettlementBatch is IMMUTABLE after assembly. Items are
//            never added, removed or modified; frozen fields are never
//            rewritten. Any change is Supersede + a NEW batch (new QS).
//
// Recorded in docs/SETTLEMENT_ENGINE_RULES.md.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { SettlementEngineService } from './settlement-engine.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

const SRC = join(__dirname, '..');
const SETTLEMENT = __dirname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const read = (p: string) => readFileSync(p, 'utf8');
const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

// ─────────────────────────────────────────────────────────────────────
describe('RULE 1 — settlement calculations live ONLY in the Settlement Engine', () => {
  const FORBIDDEN_IN_CONTROLLERS = [
    'calculateSettlement',
    'computeTax(',
    'computeMerchantGoodsTax(',
    'toMinor(',
    'fromMinor(',
    'vatOnMinor',
    'extractNetMinor',
    'allocateMoney(',
  ];

  it('no controller in src/ touches any financial-calculation primitive', () => {
    const controllers = walk(SRC).filter((p) => p.endsWith('.controller.ts'));
    // The scan must actually be scanning something.
    expect(controllers.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of controllers) {
      const text = read(file);
      for (const token of FORBIDDEN_IN_CONTROLLERS) {
        if (text.includes(token)) offenders.push(`${file} :: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('calculateSettlement is imported by the engine and specs ONLY', () => {
    const importers = walk(SRC).filter(
      (p) =>
        read(p).includes("from './settlement-calculator'") ||
        read(p).includes("from '../settlement/settlement-calculator'"),
    );
    const nonSpec = importers
      .filter((p) => !p.endsWith('.spec.ts'))
      .map((p) => p.split('/').pop());
    // The ONE lawful production consumer (§30.3 one-calculator law).
    expect(nonSpec).toEqual(['settlement-engine.service.ts']);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('RULE 2 — no direct system time in the Settlement Engine', () => {
  // Every settlement production source EXCEPT the sanctioned adapter.
  const GOVERNED = [
    'settlement-engine.service.ts',
    'settlement-calculator.ts',
    'settlement-states.ts',
    'settlement.module.ts',
  ];

  it('governed settlement sources contain zero Date.now / new Date / Math.random', () => {
    for (const name of GOVERNED) {
      const text = read(join(SETTLEMENT, name));
      expect({ name, hits: count(text, 'Date.now(') }).toEqual({
        name,
        hits: 0,
      });
      expect({ name, hits: count(text, 'new Date(') }).toEqual({
        name,
        hits: 0,
      });
      expect({ name, hits: count(text, 'Math.random(') }).toEqual({
        name,
        hits: 0,
      });
    }
  });

  it('settlement-clock.ts is the single sanctioned system-time site (exactly one new Date)', () => {
    const clock = read(join(SETTLEMENT, 'settlement-clock.ts'));
    expect(count(clock, 'new Date(')).toBe(1);
    // And the engine actually injects it.
    const engine = read(join(SETTLEMENT, 'settlement-engine.service.ts'));
    expect(count(engine, 'SETTLEMENT_CLOCK')).toBeGreaterThanOrEqual(1);
    expect(engine).toContain('private clock: SettlementClock');
  });

  it('a fixed clock makes engine time fully deterministic (both simulate paths)', async () => {
    const FIXED = '2026-07-20T12:00:00.000Z';
    const mk = (rows: unknown[]) => {
      const prisma = {
        settlementItem: {
          findMany: jest.fn().mockResolvedValue(rows),
          updateMany: jest.fn(),
        },
        settlementBatch: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          update: jest.fn(),
        },
        $transaction: jest.fn(),
      };
      const audit = { record: jest.fn().mockResolvedValue(undefined) };
      const ledger = { record: jest.fn().mockResolvedValue({ id: 'l' }) };
      return new SettlementEngineService(
        prisma as unknown as PrismaService,
        audit as unknown as AuditService,
        ledger as unknown as FinancialLedgerService,
        { now: () => new Date(FIXED) },
      );
    };
    const empty = await mk([]).simulate('u', 's-1');
    expect(empty.snapshotAt).toBe(FIXED);
    const nonEmpty = await mk([
      {
        id: 'i1',
        occurrenceType: 'merchant_invoice',
        occurrenceId: 'mi-1',
        storeId: 's-1',
        currency: 'SAR',
        amount: 100,
        state: 'eligible',
        batchId: null,
      },
    ]).simulate('u', 's-1');
    expect(nonEmpty.snapshotAt).toBe(FIXED);
    // Two runs with the same clock are IDENTICAL — replay-grade.
    const again = await mk([]).simulate('u', 's-1');
    expect(again).toEqual(empty);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('RULE 3 — SettlementBatch is immutable after assembly', () => {
  // The ONLY batch columns any engine update may ever touch. Frozen
  // forever: settlementReference, storeId, currency, windowType,
  // grossAmount, netAmount, composition, calculationSnapshot.
  const MUTABLE_BATCH_KEYS = ['status', 'failureEvidence', 'supersededById'];

  it('every settlementBatch update site in the engine writes ONLY lifecycle keys (source pin)', () => {
    const engine = read(join(SETTLEMENT, 'settlement-engine.service.ts'));
    // Pinned write-site census — a new site must be enumerated here and
    // justified against RULE 3:
    //   settlementBatch.create   1  (assembly — the freeze itself)
    //   settlementBatch.update   4  (markFailed, retry, holdBatch,
    //                                supersede: status/evidence only)
    //   settlementBatch.updateMany 1 (linkSuccessor: supersededById,
    //                                 write-once guarded)
    expect(count(engine, 'settlementBatch.create(')).toBe(1);
    expect(count(engine, 'settlementBatch.update(')).toBe(4);
    expect(count(engine, 'settlementBatch.updateMany(')).toBe(1);

    // Extract each update's data block and assert its keys.
    const sites = [
      ...engine.matchAll(
        /settlementBatch\.update(?:Many)?\(\s*\{[\s\S]*?data:\s*\{([\s\S]*?)\},?\s*\}\s*\)/g,
      ),
    ];
    expect(sites.length).toBe(5);
    for (const m of sites) {
      const keys = [...m[1].matchAll(/(?:^|[,{])\s*(\w+)\s*:/gm)].map(
        (k) => k[1],
      );
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(MUTABLE_BATCH_KEYS).toContain(key);
      }
    }
  });

  it('item membership is written at assembly (unbound-only) and supersession ONLY (source pin)', () => {
    const engine = read(join(SETTLEMENT, 'settlement-engine.service.ts'));
    // Two sites, both enumerated:
    //   assembleBatch — WHERE requires state:'eligible' AND batchId:null
    //     (an item can never be bound INTO an already-assembled batch);
    //   supersede — batch is transitioning to terminal 'superseded'.
    expect(count(engine, 'settlementItem.updateMany(')).toBe(2);
    expect(count(engine, "state: 'eligible',\n              batchId: null,")).toBe(1);
  });

  it('the engine surface is the pinned method set — no unreviewed mutator can appear', () => {
    expect(
      Object.getOwnPropertyNames(SettlementEngineService.prototype).sort(),
    ).toEqual([
      'assembleBatch',
      'constructor',
      'eligibleItems',
      'holdBatch',
      'linkSuccessor',
      'loadBatch',
      'markFailed',
      'retry',
      'simulate',
      'supersede',
    ]);
  });

  it('functionally: lifecycle moves never touch frozen fields; change requires Supersede + NEW batch/QS', async () => {
    // Minimal harness with real key-capture on every batch write.
    type Row = Record<string, unknown>;
    const items: Row[] = [
      {
        id: 'i1',
        occurrenceType: 'merchant_invoice',
        occurrenceId: 'mi-1',
        storeId: 's-1',
        currency: 'SAR',
        amount: 5750,
        state: 'eligible',
        batchId: null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ];
    const batches = new Map<string, Row>();
    const writtenKeys: string[] = [];
    let seq = 0;
    const prisma = {
      settlementItem: {
        findMany: jest.fn().mockImplementation(({ where }: never) => {
          const w = where as { batchId?: string; state?: string };
          return Promise.resolve(
            items.filter(
              (i) =>
                (w.batchId === undefined || i.batchId === w.batchId) &&
                (w.state === undefined || i.state === w.state),
            ),
          );
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
          const w = where as {
            id: string | { in: string[] };
            state?: string;
            batchId?: string | null;
          };
          const ids = typeof w.id === 'string' ? [w.id] : w.id.in;
          let n = 0;
          for (const i of items) {
            if (!ids.includes(i.id as string)) continue;
            if (w.state !== undefined && i.state !== w.state) continue;
            if (w.batchId !== undefined && i.batchId !== w.batchId) continue;
            Object.assign(i, data as Row);
            n++;
          }
          return Promise.resolve({ count: n });
        }),
      },
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
          const row = { id: `b-${++seq}`, ...(data as Row) };
          batches.set(row.id as string, row);
          return Promise.resolve(row);
        }),
        update: jest.fn().mockImplementation(({ where, data }: never) => {
          writtenKeys.push(...Object.keys(data as Row));
          const row = batches.get((where as { id: string }).id)!;
          Object.assign(row, data as Row);
          return Promise.resolve(row);
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
          writtenKeys.push(...Object.keys(data as Row));
          const w = where as Row;
          const row = batches.get(w.id as string);
          if (
            !row ||
            (w.status !== undefined && row.status !== w.status) ||
            (w.supersededById !== undefined &&
              row.supersededById !== (w.supersededById ?? null) &&
              !(w.supersededById === null && row.supersededById == null))
          ) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(row, data as Row);
          return Promise.resolve({ count: 1 });
        }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    const engine = new SettlementEngineService(
      prisma as unknown as PrismaService,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { record: jest.fn().mockResolvedValue({ id: 'l' }) } as never,
      { now: () => new Date('2026-07-20T12:00:00.000Z') },
    );

    const batch = (await engine.assembleBatch('u', 's-1')) as Row;
    const frozen = JSON.parse(
      JSON.stringify({
        settlementReference: batch.settlementReference,
        storeId: batch.storeId,
        currency: batch.currency,
        grossAmount: batch.grossAmount,
        netAmount: batch.netAmount,
        composition: batch.composition,
        calculationSnapshot: batch.calculationSnapshot,
        windowType: batch.windowType,
      }),
    );

    // Walk the full lifecycle lane — none of it may touch frozen state.
    await engine.markFailed('u', batch.id as string, 'psp timeout');
    await engine.retry('u', batch.id as string);
    await engine.markFailed('u', batch.id as string, 'psp timeout again');
    await engine.holdBatch('u', batch.id as string, 'investigating');
    const after = batches.get(batch.id as string)!;
    for (const [k, v] of Object.entries(frozen)) {
      expect(JSON.parse(JSON.stringify(after[k]))).toEqual(v);
    }
    // Every batch write across the whole lane used lifecycle keys only.
    expect([...new Set(writtenKeys)].sort()).toEqual([
      'failureEvidence',
      'status',
    ]);

    // The ONLY lawful change path: Supersede → terminal → NEW batch + NEW QS.
    await engine.supersede('u', batch.id as string, 'withdrawn');
    expect(batches.get(batch.id as string)!.status).toBe('superseded');
    expect(items[0].state).toBe('eligible');
    expect(items[0].batchId).toBeNull();
    const successor = (await engine.assembleBatch('u', 's-1')) as Row;
    expect(successor.id).not.toBe(batch.id);
    expect(successor.settlementReference).not.toBe(frozen.settlementReference);
    await engine.linkSuccessor(batch.id as string, successor.id as string);
    // And the superseded original STILL carries its frozen record intact.
    const original = batches.get(batch.id as string)!;
    for (const k of ['composition', 'calculationSnapshot', 'netAmount']) {
      expect(JSON.parse(JSON.stringify(original[k]))).toEqual(
        frozen[k as keyof typeof frozen],
      );
    }
  });
});
