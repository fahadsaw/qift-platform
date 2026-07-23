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
import { calculateSettlement } from './settlement-calculator';
import {
  calculationHash,
  canonicalJson,
  generateSettlementStatement,
  hashCanonical,
  signableDigest,
  statementHash,
  type FrozenBatchRecord,
} from './settlement-statement';
import {
  assertExecutionBinding,
  buildExecutionPreview,
  type ExecutionApproval,
} from './settlement-execution-binding';
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

  it('calculateSettlement is imported by the engine, the execution-binding law, and specs ONLY', () => {
    const importers = walk(SRC).filter(
      (p) =>
        read(p).includes("from './settlement-calculator'") ||
        read(p).includes("from '../settlement/settlement-calculator'"),
    );
    const nonSpec = importers
      .filter((p) => !p.endsWith('.spec.ts'))
      .map((p) => p.split('/').pop())
      .sort();
    // The TWO lawful CALCULATING consumers (§30.3 one-calculator law):
    // the engine (simulate + assemble) and the execution-binding
    // module (RULE 5 — recompute-and-COMPARE only, never output).
    // settlement-statement.ts imports the TYPE only (erased);
    // settlement-execution.service.ts imports ONLY the currency
    // guard (asCurrencyCode) — both are pinned below to ZERO
    // calculateSettlement invocations.
    expect(nonSpec).toEqual([
      // Lane 2 PR 3 (Scopes C+H): the integrity spec and the treasury
      // transfer service import ONLY asCurrencyCode (the currency
      // registry guard carrying the 3-dp refusal) — pinned below to
      // ZERO calculateSettlement invocations.
      'settlement-engine.service.ts',
      'settlement-execution-binding.ts',
      'settlement-execution.service.ts',
      'settlement-statement.ts',
      'treasury-internal-transfer.service.ts',
    ]);
    for (const nonCalculating of [
      join(SETTLEMENT, 'settlement-statement.ts'),
      join(SETTLEMENT, 'settlement-execution.service.ts'),
      join(SETTLEMENT, '..', 'treasury', 'treasury-internal-transfer.service.ts'),
    ]) {
      expect({
        file: nonCalculating,
        hits: count(read(nonCalculating), 'calculateSettlement'),
      }).toEqual({ file: nonCalculating, hits: 0 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('RULE 2 — no direct system time in the Settlement Engine', () => {
  // Every settlement production source EXCEPT the sanctioned adapter.
  // PURE files may not construct Date at all; SERVICE files may parse
  // operator-supplied dates (new Date(<evidence string>) is data, not
  // time) but never read the machine clock (bare new Date() or
  // Date.now()).
  const GOVERNED_PURE = [
    'settlement-engine.service.ts',
    'settlement-calculator.ts',
    'settlement-states.ts',
    'settlement.module.ts',
    // RULES 4-6 modules: pure functions over frozen data — every date
    // is a supplied business fact (crypto hashing is deterministic
    // and lawful).
    'settlement-statement.ts',
    'settlement-execution-binding.ts',
    // §31–§32 policy: structure canon, values versioned policy — pure.
    'settlement-approval-policy.ts',
    // RC v3.0 invariants: credit-note document law + receivable
    // lifecycle law — pure.
    'settlement-credit-note.ts',
    'settlement-receivable-states.ts',
  ];
  const GOVERNED_SERVICES = [
    'settlement-receipts.service.ts',
    'settlement-eligibility.service.ts',
    // SETTLE-2 execution surface: clock-injected (TTL, issuance);
    // bank dates are supplied evidence; batch access via engine only.
    'settlement-execution.service.ts',
    // SETTLE-3a refunds: clock-injected; refund dates are supplied
    // evidence; touches items (guarded) but NEVER batches.
    'settlement-refunds.service.ts',
  ];

  it('pure settlement sources contain zero Date.now / new Date / Math.random', () => {
    for (const name of GOVERNED_PURE) {
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

  it('settlement services never read the machine clock and inject SettlementClock', () => {
    for (const name of GOVERNED_SERVICES) {
      const text = read(join(SETTLEMENT, name));
      expect({ name, hits: count(text, 'Date.now(') }).toEqual({
        name,
        hits: 0,
      });
      // Bare construction = a system-time read.
      expect({ name, hits: count(text, 'new Date()') }).toEqual({
        name,
        hits: 0,
      });
      expect({ name, hits: count(text, 'Math.random(') }).toEqual({
        name,
        hits: 0,
      });
      expect(count(text, 'SETTLEMENT_CLOCK')).toBeGreaterThanOrEqual(1);
    }
  });

  it('settlement services never touch SettlementBatch — batch mutation is engine-only', () => {
    for (const name of GOVERNED_SERVICES) {
      const text = read(join(SETTLEMENT, name));
      expect({ name, hits: count(text, 'settlementBatch') }).toEqual({
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
      settlementReceivable: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },

        settlementBatch: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          update: jest.fn(),
        },
        $transaction: jest.fn(),
      };
      const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordGuaranteed: jest.fn().mockResolvedValue(undefined),
  };
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
  // closureType/closedAt (Lane 2 PR 2, SC §26): HOW/WHEN the terminal
  // state was reached — written once, atomically with the close, in
  // the RULE 3 lifecycle sense (like failureEvidence).
  const MUTABLE_BATCH_KEYS = [
    'status',
    'failureEvidence',
    'supersededById',
    'closureType',
    'closedAt',
  ];

  it('every settlementBatch update site in the engine writes ONLY lifecycle keys (source pin)', () => {
    const engine = read(join(SETTLEMENT, 'settlement-engine.service.ts'));
    // Pinned write-site census — a new site must be enumerated here and
    // justified against RULE 3:
    //   settlementBatch.create   1  (assembly — the freeze itself;
    //                                assembledBy is a create-time
    //                                frozen fact, §31.1 proposer)
    //   settlementBatch.update   4  (markFailed, retry, holdBatch,
    //                                supersede: status/evidence only)
    //   settlementBatch.updateMany 3 (linkSuccessor: supersededById,
    //                                 write-once guarded; markSettled:
    //                                 guarded ready→settled + the §26
    //                                 closureType='remitted'/closedAt
    //                                 stamp, SETTLE-2 + Lane 2 PR 2;
    //                                 markSettledZeroNet: guarded
    //                                 ready→settled + closureType=
    //                                 'zero_net_no_transfer'/closedAt —
    //                                 the statement-only close, NO
    //                                 remittance created)
    expect(count(engine, 'settlementBatch.create(')).toBe(1);
    expect(count(engine, 'settlementBatch.update(')).toBe(4);
    expect(count(engine, 'settlementBatch.updateMany(')).toBe(3);

    // Extract each update's data block and assert its keys.
    const sites = [
      ...engine.matchAll(
        /settlementBatch\.update(?:Many)?\(\s*\{[\s\S]*?data:\s*\{([\s\S]*?)\},?\s*\}\s*\)/g,
      ),
    ];
    expect(sites.length).toBe(7);
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
    // Three sites, all enumerated:
    //   assembleBatch — WHERE requires state:'eligible' AND batchId:null
    //     (an item can never be bound INTO an already-assembled batch);
    //   supersede — batch is transitioning to terminal 'superseded';
    //   markSettled — guarded ready→settled of the batch's OWN items
    //     (SETTLE-2), count-checked against the frozen composition;
    //   markSettledZeroNet — the SAME guarded ready→settled of the
    //     batch's own items for the §26 statement-only close
    //     (Lane 2 PR 2), count-checked identically.
    expect(count(engine, 'settlementItem.updateMany(')).toBe(4);
    // The bind guard pins state + unbound + the EXACT frozen amount
    // (SETTLE-3a review finding 1: amounts became mutable via refunds;
    // a racing shrink must fail the bind, never freeze stale money).
    expect(
      count(
        engine,
        "state: 'eligible',\n                batchId: null,\n                amount: item.amount,",
      ),
    ).toBe(1);
  });

  it('the engine surface is the pinned method set — no unreviewed mutator can appear', () => {
    expect(
      Object.getOwnPropertyNames(SettlementEngineService.prototype).sort(),
    ).toEqual([
      'assembleBatch',
      'batchItems', // SETTLE-2 read seam (items of a batch)
      'constructor',
      'consumeRecoveryAllocation', // Scope G (Lane 2 PR 3): the ONE §7.4 consumption path — both terminal lanes call it
      'eligibleItems',
      'frozenRecord', // SETTLE-2 read seam (the §34 frozen record)
      'holdBatch',
      'linkSuccessor',
      'listBatches', // SETTLE-2 read seam (admin listing)
      'loadBatch',
      'markFailed',
      'markSettled', // SETTLE-2: ready→settled + completed marker
      'markSettledZeroNet', // Lane 2 PR 2 (§26): statement-only close — NO remittance
      'occurrenceReferences', // §15.1 reference denormalization at assembly
      'planRecovery', // §7.4 offset planning (SETTLE-3b)
      'retry',
      'simulate',
      'supersede',
      'zeroNetClosedGrossMinor', // §32.3 read seam: zero-net day-aggregate (Lane 2 PR 2)
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
      merchantInvoice: { findMany: jest.fn().mockResolvedValue([]) },
      giftCampaign: { findMany: jest.fn().mockResolvedValue([]) },
      settlementRemittance: { findUnique: jest.fn().mockResolvedValue(null) },
      settlementReceivable: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
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
            amount?: unknown;
          };
          const ids = typeof w.id === 'string' ? [w.id] : w.id.in;
          let n = 0;
          for (const i of items) {
            if (!ids.includes(i.id as string)) continue;
            if (w.state !== undefined && i.state !== w.state) continue;
            if (w.batchId !== undefined && i.batchId !== w.batchId) continue;
            if (w.amount !== undefined && i.amount !== w.amount) continue;
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
      {
        record: jest.fn().mockResolvedValue(undefined),
        recordGuaranteed: jest.fn().mockResolvedValue(undefined),
      } as never,
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

// ─────────────────────────────────────────────────────────────────────
// RULES 4–6 (enacted after PR #84): the Settlement Statement is a
// constitutional, replay-identical output; an Execution Preview must
// exist before Execute using the ONE calculator; execution binds to an
// approved preview's IDENTICAL frozen calculation snapshot.
// ─────────────────────────────────────────────────────────────────────

function frozenFixture(): FrozenBatchRecord {
  const composition: FrozenBatchRecord['composition'] = [
    {
      itemId: 'sitem-1',
      occurrenceType: 'merchant_invoice',
      occurrenceId: 'minv-1',
      amount: 5750,
      currency: 'SAR',
      references: { merchantInvoiceNumber: 'DAT-2026-0042' },
    },
    {
      itemId: 'sitem-2',
      occurrenceType: 'merchant_invoice',
      occurrenceId: 'minv-2',
      amount: 2300.5,
      currency: 'SAR',
      references: {},
    },
  ];
  return {
    settlementId: 'stl-1',
    settlementReference: 'QS-K7MP-4WX2',
    storeId: 's-daralteeb',
    currency: 'SAR',
    windowType: 'manual',
    composition,
    calculationSnapshot: calculateSettlement(
      composition.map((c) => ({
        itemId: c.itemId,
        occurrenceType: c.occurrenceType,
        occurrenceId: c.occurrenceId,
        amount: c.amount,
        currency: c.currency,
      })),
    ),
  };
}

describe('RULE 4 — the Settlement Statement is a constitutional, replay-identical output', () => {
  it('same frozen inputs → byte-identical statement and hash, every time', () => {
    const a = generateSettlementStatement(frozenFixture(), {
      issuedAt: '2026-07-22T10:00:00.000Z',
    });
    const b = generateSettlementStatement(frozenFixture(), {
      issuedAt: '2026-07-22T10:00:00.000Z',
    });
    expect(b).toEqual(a);
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(statementHash(b)).toBe(statementHash(a));
    // The statement quotes its QS and every §4 line VERBATIM.
    expect(a.settlementReference).toBe('QS-K7MP-4WX2');
    expect(a.lines).toEqual(frozenFixture().calculationSnapshot.lines);
    expect(a.netAmount).toBe(8050.5);
    expect(a.coveredOccurrences[0].references.merchantInvoiceNumber).toBe(
      'DAT-2026-0042',
    );
  });

  it('the statement RENDERS frozen data — it never recomputes (a tampered snapshot flows through, changing the hash)', () => {
    const frozen = frozenFixture();
    const before = generateSettlementStatement(frozen, {
      issuedAt: '2026-07-22T10:00:00.000Z',
    });
    // Tamper the frozen snapshot: a recomputing generator would mask
    // this; a constitutional renderer must surface it verbatim.
    frozen.calculationSnapshot.netAmount = 1;
    const after = generateSettlementStatement(frozen, {
      issuedAt: '2026-07-22T10:00:00.000Z',
    });
    expect(after.netAmount).toBe(1);
    expect(after.calculationHash).not.toBe(before.calculationHash);
    expect(statementHash(after)).not.toBe(statementHash(before));
  });

  it('every date on a statement is a SUPPLIED business fact (issuedAt, remittance evidence)', () => {
    const stmt = generateSettlementStatement(frozenFixture(), {
      issuedAt: '2026-07-22T10:00:00.000Z',
      remittance: {
        remittanceId: 'rem-1',
        bankTransferReference: 'BANK-OUT-7001',
        executedAt: '2026-07-22T09:45:00.000Z',
        amount: 8050.5,
      },
    });
    expect(stmt.issuedAt).toBe('2026-07-22T10:00:00.000Z');
    expect(stmt.remittance).toEqual({
      remittanceId: 'rem-1',
      bankTransferReference: 'BANK-OUT-7001',
      executedAt: '2026-07-22T09:45:00.000Z',
      amount: 8050.5,
    });
  });

  it('purity source pins: the statement module touches no framework, no DB, no clock', () => {
    const src = read(join(SETTLEMENT, 'settlement-statement.ts'));
    expect(count(src, '@nestjs')).toBe(0);
    expect(count(src, 'prisma')).toBe(0);
    expect(count(src, 'PrismaService')).toBe(0);
    // Exactly two import sources: crypto (deterministic hashing) and
    // the calculator TYPE.
    const importSources = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(importSources.sort()).toEqual([
      './settlement-calculator',
      'crypto',
    ]);
  });

  it('HARDENING: the hash derives from the canonical JSON bytes ONLY, and signatures sign that digest', () => {
    const stmt = generateSettlementStatement(frozenFixture(), {
      issuedAt: '2026-07-22T10:00:00.000Z',
    });
    // One serialization, one digest: statementHash ≡ sha256(canonical).
    expect(statementHash(stmt)).toBe(hashCanonical(canonicalJson(stmt)));
    // The signature seam signs the SAME canonical digest — never the
    // payload object or a rendering.
    expect(signableDigest(stmt)).toBe(statementHash(stmt));
  });

  it('HARDENING: presentation layers add nothing — settlement production sources contain no PDF machinery', () => {
    for (const name of walk(SETTLEMENT).filter(
      (f) => !f.endsWith('.spec.ts'),
    )) {
      const text = read(name).toLowerCase();
      expect({ name, hits: count(text, 'pdf') }).toEqual({ name, hits: 0 });
    }
  });

  it('canonicalJson is key-order independent — the hash names the DATA, not the construction', () => {
    const a = { x: 1, y: { b: 2, a: 3 }, z: [1, 2] };
    const b = { z: [1, 2], y: { a: 3, b: 2 }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    // One halala of difference → a different name.
    const s1 = frozenFixture().calculationSnapshot;
    const s2 = frozenFixture().calculationSnapshot;
    s2.netAmount = s2.netAmount + 0.01;
    expect(calculationHash(s1)).not.toBe(calculationHash(s2));
  });
});

describe('RULE 5 — Execution Preview before Execute, on the ONE calculator', () => {
  it('the preview renders the FROZEN snapshot and §34-verifies it via the one calculator', () => {
    const preview = buildExecutionPreview(frozenFixture(), {
      asOf: '2026-07-22T08:00:00.000Z',
    });
    expect(preview.preview).toBe(true);
    expect(preview.netAmount).toBe(8050.5);
    expect(preview.replayVerified).toBe(true);
    expect(preview.calculationHash).toBe(
      calculationHash(frozenFixture().calculationSnapshot),
    );
    // The draft is the SAME generator execution will use (RULE 4).
    expect(preview.statementDraft).toEqual(
      generateSettlementStatement(frozenFixture(), {
        issuedAt: '2026-07-22T08:00:00.000Z',
        remittance: null,
      }),
    );
  });

  it('a frozen record that no longer reproduces itself is SURFACED, never masked', () => {
    const frozen = frozenFixture();
    frozen.calculationSnapshot.netAmount = 999999;
    const preview = buildExecutionPreview(frozen, {
      asOf: '2026-07-22T08:00:00.000Z',
    });
    expect(preview.replayVerified).toBe(false);
    // The preview still renders the FROZEN value — the recomputed one
    // is never substituted (frozen data is the only truth; refusal
    // happens at the binding gate).
    expect(preview.netAmount).toBe(999999);
  });

  it('purity source pin: the binding module uses the calculator to COMPARE, and reads no clock/DB/framework', () => {
    const src = read(join(SETTLEMENT, 'settlement-execution-binding.ts'));
    expect(count(src, '@nestjs')).toBe(0);
    expect(count(src, 'prisma')).toBe(0);
    const importSources = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(importSources.sort()).toEqual([
      './settlement-calculator',
      './settlement-statement',
    ]);
  });
});

describe('RULE 6 — execution only from an approved preview; one identical frozen snapshot end to end', () => {
  const approval = (over: Partial<ExecutionApproval> = {}): ExecutionApproval => ({
    settlementId: 'stl-1',
    settlementReference: 'QS-K7MP-4WX2',
    calculationHash: calculationHash(frozenFixture().calculationSnapshot),
    approvedBy: 'founder-finance',
    level: 1,
    approvedAt: '2026-07-22T08:30:00.000Z',
    ...over,
  });

  it('the lawful chain passes: frozen ≡ preview ≡ approval, executor ∉ approvers', () => {
    const frozen = frozenFixture();
    const preview = buildExecutionPreview(frozen, {
      asOf: '2026-07-22T08:00:00.000Z',
    });
    expect(() =>
      assertExecutionBinding(frozen, preview, [approval()], 'ops-executor'),
    ).not.toThrow();
  });

  it('refusal matrix: every break in the chain throws its named violation', () => {
    const frozen = frozenFixture();
    const preview = buildExecutionPreview(frozen, {
      asOf: '2026-07-22T08:00:00.000Z',
    });
    // No approval at all.
    expect(() =>
      assertExecutionBinding(frozen, preview, [], 'ops-executor'),
    ).toThrow('illegal_execution_binding:approval_required');
    // The frozen snapshot changed AFTER preview — stale preview.
    const drifted = frozenFixture();
    drifted.calculationSnapshot.netAmount = 1;
    expect(() =>
      assertExecutionBinding(drifted, preview, [approval()], 'ops-executor'),
    ).toThrow('illegal_execution_binding:preview_snapshot_mismatch');
    // A preview from a DIFFERENT batch.
    expect(() =>
      assertExecutionBinding(
        frozen,
        { ...preview, settlementId: 'stl-OTHER' },
        [approval()],
        'ops-executor',
      ),
    ).toThrow('illegal_execution_binding:preview_batch_mismatch');
    // An approval quoting a DIFFERENT calculation.
    expect(() =>
      assertExecutionBinding(
        frozen,
        preview,
        [approval({ calculationHash: 'deadbeef' })],
        'ops-executor',
      ),
    ).toThrow('illegal_execution_binding:approval_snapshot_mismatch');
    // An approval for a different batch.
    expect(() =>
      assertExecutionBinding(
        frozen,
        preview,
        [approval({ settlementId: 'stl-OTHER' })],
        'ops-executor',
      ),
    ).toThrow('illegal_execution_binding:approval_batch_mismatch');
    // §34 failed — nothing executes off a self-inconsistent record.
    expect(() =>
      assertExecutionBinding(
        frozen,
        { ...preview, replayVerified: false },
        [approval()],
        'ops-executor',
      ),
    ).toThrow('illegal_execution_binding:replay_not_verified');
    // §33 separation, strict form: executor among approvers.
    expect(() =>
      assertExecutionBinding(frozen, preview, [approval()], 'founder-finance'),
    ).toThrow('illegal_execution_binding:executor_cannot_approve');
  });

  it('no execution can calculate independently: the binding names ONE frozen snapshot for all three stages', () => {
    const frozen = frozenFixture();
    const preview = buildExecutionPreview(frozen, {
      asOf: '2026-07-22T08:00:00.000Z',
    });
    const a = approval();
    // One hash, three carriers — Preview ↓ Approval ↓ Execute.
    expect(preview.calculationHash).toBe(
      calculationHash(frozen.calculationSnapshot),
    );
    expect(a.calculationHash).toBe(preview.calculationHash);
    // And the statement execution will issue carries the same token.
    expect(preview.statementDraft.calculationHash).toBe(
      preview.calculationHash,
    );
  });
});
