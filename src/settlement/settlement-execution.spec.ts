// SETTLE-2 execution service — unit pins (Track C PR 3).
//
// Exercises §31–§33 + RULES 4–6 at the service layer: the RULE 6
// binding gate, proposer/approver/executor separation, the §31.3 TTL,
// the §32 level requirement with anti-fragmentation, §33.3 drift
// refusal, the idempotent execution chain, and the §34 replay harness.

import { SettlementEngineService } from './settlement-engine.service';
import { SettlementExecutionService } from './settlement-execution.service';
import { calculateSettlement } from './settlement-calculator';
import {
  calculationHash as hashCalc,
  canonicalJson,
  hashCanonical,
  statementHash,
} from './settlement-statement';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const SENIOR_ENV = 'QIFT_SETTLEMENT_SENIOR_APPROVERS';
const T0 = '2026-07-22T09:00:00.000Z';

function world(opts?: { net?: number; assembledBy?: string | null }) {
  const net = opts?.net ?? 5750;
  let seq = 0;
  const snapshot = calculateSettlement([
    {
      itemId: 'i-1',
      occurrenceType: 'merchant_invoice',
      occurrenceId: 'mi-1',
      amount: net,
      currency: 'SAR',
    },
  ]);
  const batches = new Map<string, Row>([
    [
      'stl-1',
      {
        id: 'stl-1',
        settlementReference: 'QS-TEST-0001',
        storeId: 's-1',
        currency: 'SAR',
        status: 'ready',
        windowType: 'manual',
        grossAmount: net,
        netAmount: net,
        composition: [
          {
            itemId: 'i-1',
            occurrenceType: 'merchant_invoice',
            occurrenceId: 'mi-1',
            amount: net,
            currency: 'SAR',
            references: { merchantInvoiceNumber: 'DAT-2026-0042' },
          },
        ],
        calculationSnapshot: snapshot,
        assembledBy:
          opts?.assembledBy === undefined ? 'proposer-1' : opts.assembledBy,
      },
    ],
  ]);
  const items: Row[] = [
    { id: 'i-1', state: 'ready', batchId: 'stl-1', createdAt: new Date(T0) },
  ];
  const approvals: Row[] = [];
  const previews: Row[] = [];
  const remittances: Row[] = [];
  const statements: Row[] = [];
  const replayRecords: Row[] = [];
  const ledgerRows: Row[] = [];
  const auditRows: Row[] = [];
  const clockState = { now: new Date(T0) };

  const prisma = {
    merchantInvoice: { findMany: jest.fn().mockResolvedValue([]) },
    giftCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    settlementBatch: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: never) =>
          Promise.resolve(batches.get((where as Row).id as string) ?? null),
        ),
      findMany: jest.fn().mockResolvedValue([...batches.values()]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        const row = batches.get(w.id as string);
        if (!row || (w.status !== undefined && row.status !== w.status)) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(row, data as Row);
        return Promise.resolve({ count: 1 });
      }),
    },
    settlementItem: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as Row;
        return Promise.resolve(
          items.filter(
            (i) => w.batchId === undefined || i.batchId === w.batchId,
          ),
        );
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as {
          id?: { in: string[] };
          batchId?: string;
          state?: string;
        };
        let count = 0;
        for (const i of items) {
          if (w.id && !w.id.in.includes(i.id as string)) continue;
          if (w.batchId !== undefined && i.batchId !== w.batchId) continue;
          if (w.state !== undefined && i.state !== w.state) continue;
          Object.assign(i, data as Row);
          count++;
        }
        return Promise.resolve({ count });
      }),
    },
    settlementExecutionPreview: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `prev-${++seq}`, ...(data as Row) };
        previews.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) =>
        Promise.resolve(
          previews.filter(
            (p) =>
              p.settlementId === (where as Row).settlementId &&
              p.calculationHash === (where as Row).calculationHash,
          ),
        ),
      ),
    },
    settlementApproval: {
      // DB law: @@unique([settlementId, approvedBy, approvedAt]) —
      // per-ROUND votes; the active-vote rule lives in the service.
      create: jest.fn().mockImplementation(({ data }: never) => {
        const d = data as Row;
        if (
          approvals.some(
            (a) =>
              a.settlementId === d.settlementId &&
              a.approvedBy === d.approvedBy &&
              (a.approvedAt as Date).getTime() ===
                (d.approvedAt as Date).getTime(),
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row = { id: `apr-${++seq}`, ...d };
        approvals.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as Row;
        return Promise.resolve(
          approvals.filter(
            (a) =>
              a.settlementId === w.settlementId &&
              (w.approvedBy === undefined || a.approvedBy === w.approvedBy),
          ),
        );
      }),
    },
    settlementRemittance: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const d = data as Row;
        if (remittances.some((r) => r.settlementId === d.settlementId)) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        // createdAt = DB default now() — modeled off the test clock.
        const row = {
          id: `rem-${++seq}`,
          createdAt: new Date(clockState.now),
          ...d,
        };
        remittances.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) =>
        Promise.resolve(
          remittances.find(
            (r) => r.settlementId === (where as Row).settlementId,
          ) ?? null,
        ),
      ),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as {
          storeId: string;
          currency: string;
          settlementId?: { not: string };
          executedAt?: { gte: Date; lt: Date };
          createdAt?: { gte: Date; lt: Date };
        };
        const basis = w.executedAt ? 'executedAt' : 'createdAt';
        const win = (w.executedAt ?? w.createdAt)!;
        return Promise.resolve(
          remittances.filter(
            (r) =>
              r.storeId === w.storeId &&
              r.currency === w.currency &&
              (w.settlementId === undefined ||
                r.settlementId !== w.settlementId.not) &&
              (r[basis] as Date) >= win.gte &&
              (r[basis] as Date) < win.lt,
          ),
        );
      }),
    },
    settlementReplayRecord: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `rpl-${++seq}`, ...(data as Row) };
        replayRecords.push(row);
        return Promise.resolve(row);
      }),
    },
    settlementStatementSignature: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    settlementStatementRecord: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const d = data as Row;
        if (statements.some((r) => r.settlementId === d.settlementId)) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row = { id: `stmt-${++seq}`, ...d };
        statements.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) =>
        Promise.resolve(
          statements.find(
            (r) => r.settlementId === (where as Row).settlementId,
          ) ?? null,
        ),
      ),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const audit = {
    record: jest.fn().mockImplementation((row: Row) => {
      auditRows.push(row);
      return Promise.resolve(undefined);
    }),
  };
  const ledger = {
    record: jest.fn().mockImplementation((row: Row) => {
      const existing = ledgerRows.find(
        (r) => r.idempotencyKey === row.idempotencyKey,
      );
      if (existing) return Promise.resolve(existing);
      ledgerRows.push(row);
      return Promise.resolve(row);
    }),
  };
  const clock = { now: () => new Date(clockState.now) };
  const engine = new SettlementEngineService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledger as unknown as FinancialLedgerService,
    clock,
  );
  const exec = new SettlementExecutionService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledger as unknown as FinancialLedgerService,
    engine,
    clock,
  );
  return {
    exec,
    engine,
    prisma,
    batches,
    items,
    approvals,
    previews,
    remittances,
    statements,
    replayRecords,
    ledgerRows,
    auditRows,
    clockState,
  };
}

const EXEC_INPUT = (previewHash: string) => ({
  previewHash,
  bankTransferReference: 'BANK-OUT-7001',
  executedAt: '2026-07-22T08:45:00.000Z',
});

describe('SettlementExecutionService (SETTLE-2)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
    delete process.env[SENIOR_ENV];
  });

  it('preview: ready-only, frozen values, counts-only audit', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    expect(p.replayVerified).toBe(true);
    expect(p.netAmount).toBe(5750);
    expect(
      w.auditRows.find((a) => a.action === 'settlement.execution.previewed'),
    ).toBeTruthy();
    w.batches.get('stl-1')!.status = 'failed';
    await expect(w.exec.preview('finance-2', 'stl-1')).rejects.toThrow(
      'preview_requires_ready:failed',
    );
  });

  it('§31.1 approval law: proposer refused, stale hash refused, one vote per identity', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await expect(
      w.exec.approve('proposer-1', 'stl-1', { calculationHash: p.calculationHash }),
    ).rejects.toThrow('approver_cannot_be_proposer');
    await expect(
      w.exec.approve('finance-2', 'stl-1', { calculationHash: 'deadbeef' }),
    ).rejects.toThrow('approval_snapshot_stale');
    const res = await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    expect(res.requirement.level).toBe(2); // 5,750 → T1..T2 band
    await expect(
      w.exec.approve('finance-2', 'stl-1', { calculationHash: p.calculationHash }),
    ).rejects.toThrow('already_approved_by_user');
    // A batch with no recorded proposer cannot enter the chain.
    const w2 = world({ assembledBy: null });
    const p2 = await w2.exec.preview('finance-2', 'stl-1');
    await expect(
      w2.exec.approve('finance-2', 'stl-1', { calculationHash: p2.calculationHash }),
    ).rejects.toThrow('batch_proposer_unknown');
  });

  it('the lawful chain executes: preparer-execution, remittance = frozen net, markers, statement', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    // §33.2: A proposed, B approved, A executes — lawful.
    const res = await w.exec.execute(
      'proposer-1',
      'stl-1',
      EXEC_INPUT(p.calculationHash),
    );
    expect(w.batches.get('stl-1')!.status).toBe('settled');
    expect(w.items[0].state).toBe('settled');
    // Remittance amount comes from the FROZEN snapshot, never input.
    expect((res.remittance as Row).amount).toBe(5750);
    const remitted = w.ledgerRows.find(
      (r) => r.eventType === 'merchant.remittance.paid',
    )!;
    expect(remitted).toMatchObject({
      amount: 5750,
      direction: 'credit',
      idempotencyKey: `merchant.remittance.paid:${(res.remittance as Row).id}`,
    });
    const completed = w.ledgerRows.find(
      (r) => r.eventType === 'settlement.completed',
    )!;
    expect(completed).toMatchObject({
      amount: 0,
      idempotencyKey: 'settlement.completed:stl-1',
    });
    // RULE 4 statement: stored immutable, hash-pinned, references carried.
    const stmt = w.statements[0];
    const payload = stmt.payload as Row;
    expect(stmt.statementHash).toBe(statementHash(payload as never));
    expect(payload.settlementReference).toBe('QS-TEST-0001');
    expect(
      (payload.coveredOccurrences as Row[])[0].references,
    ).toMatchObject({ merchantInvoiceNumber: 'DAT-2026-0042' });
    expect((payload.remittance as Row).bankTransferReference).toBe(
      'BANK-OUT-7001',
    );
    // §33.4 evidence chain audit.
    const audit = w.auditRows.find(
      (a) => a.action === 'settlement.batch.executed',
    )!;
    expect(audit.metadata).toMatchObject({
      proposer: 'proposer-1',
      approvedBy: ['finance-2'],
      executedBy: 'proposer-1',
    });
  });

  it('RULE 6 refusals at the service: no approval, executor=approver, preview hash mismatch, drift', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('illegal_execution_binding:approval_required');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    await expect(
      w.exec.execute('finance-2', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('illegal_execution_binding:executor_cannot_approve');
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT('deadbeef')),
    ).rejects.toThrow('preview_hash_mismatch');
    // §33.3 drift: a hold lands on the item → refuse, re-simulation lane.
    w.items[0].state = 'held';
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('batch_drifted');
  });

  it('§31.3 TTL: lapsed previews and approvals demand FRESH acts — and a lapsed vote may be recast', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    w.clockState.now = new Date('2026-07-25T09:00:01.000Z'); // 72h + 1s
    // The preview act lapsed with everything else (§30.6 staleness).
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('preview_act_required');
    // Fresh preview, but the approval is still lapsed → refused.
    await w.exec.preview('finance-2', 'stl-1');
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('illegal_execution_binding:approval_required');
    // §31.5 per-round law: the SAME approver recasts the lapsed vote
    // as a NEW immutable row, and execution proceeds.
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    const res = await w.exec.execute('proposer-1', 'stl-1', {
      previewHash: p.calculationHash,
      bankTransferReference: 'BANK-OUT-7001',
      executedAt: '2026-07-25T08:00:00.000Z',
    });
    expect((res.remittance as Row).amount).toBe(5750);
    expect(w.approvals).toHaveLength(2); // both votes immutable
  });

  it('§32 L3: above T2 needs TWO approvers including a SENIOR seat — without one it cannot execute', async () => {
    const w = world({ net: 60000 }); // > SAR 50,000 → L3
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('insufficient_approvals');
    await w.exec.approve('finance-3', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    delete process.env[SENIOR_ENV];
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('senior_approval_required');
    process.env[SENIOR_ENV] = 'finance-3';
    const res = await w.exec.execute(
      'proposer-1',
      'stl-1',
      EXEC_INPUT(p.calculationHash),
    );
    expect((res.remittance as Row).amount).toBe(60000);
    delete process.env[SENIOR_ENV];
  });

  it('§32.3 anti-fragmentation: the day aggregate raises the band across fragments', async () => {
    const w = world({ net: 30000 }); // alone: L2
    // 25k already remitted for the same store on the SAME bank day.
    w.remittances.push({
      id: 'rem-prior',
      settlementId: 'stl-prior',
      settlementReference: 'QS-PRIO-0001',
      storeId: 's-1',
      currency: 'SAR',
      amount: 25000,
      bankTransferReference: 'BANK-OUT-6999',
      executedAt: new Date('2026-07-22T07:00:00.000Z'),
      createdAt: new Date('2026-07-22T07:00:00.000Z'),
      executedBy: 'proposer-1',
    });
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    // Aggregate 55k > T2 ⇒ L3 ⇒ one approval is not enough.
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('insufficient_approvals');
  });

  it('§32.3 backdating inside the window still cannot duck the band — the RECORDING day aggregates on server truth', async () => {
    const w = world({ net: 30000 }); // alone: L2
    // 25k truly moved and RECORDED today, but the operator wrote
    // yesterday's value date (inside the 168h window).
    w.remittances.push({
      id: 'rem-backdated',
      settlementId: 'stl-prior',
      settlementReference: 'QS-PRIO-0001',
      storeId: 's-1',
      currency: 'SAR',
      amount: 25000,
      bankTransferReference: 'BANK-OUT-6998',
      executedAt: new Date('2026-07-21T07:00:00.000Z'), // faked value day
      createdAt: new Date(T0), // server truth: recorded TODAY
      executedBy: 'proposer-1',
    });
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    // Value-day aggregate misses the faked row; the createdAt
    // aggregate catches it: 30k + 25k = 55k > T2 ⇒ L3.
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash)),
    ).rejects.toThrow('insufficient_approvals');
  });

  it('idempotent chain: same evidence re-run heals and returns; different evidence conflicts', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    const first = await w.exec.execute(
      'proposer-1',
      'stl-1',
      EXEC_INPUT(p.calculationHash),
    );
    const ledgerCount = w.ledgerRows.length;
    const again = await w.exec.execute(
      'proposer-1',
      'stl-1',
      EXEC_INPUT(p.calculationHash),
    );
    expect((again.remittance as Row).id).toBe((first.remittance as Row).id);
    expect(w.ledgerRows.length).toBe(ledgerCount); // postings collided
    expect(w.statements).toHaveLength(1);
    await expect(
      w.exec.execute('proposer-1', 'stl-1', {
        ...EXEC_INPUT(p.calculationHash),
        bankTransferReference: 'BANK-OUT-9999',
      }),
    ).rejects.toThrow('remittance_conflict');
  });

  it('zero/negative nets never fabricate a transfer — zero redirects to the §26 close, negative stays deferred', async () => {
    const w = world();
    (w.batches.get('stl-1')!.calculationSnapshot as Row).netAmount = 0;
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT('x')),
    ).rejects.toThrow('execution_use_zero_net_close');
    (w.batches.get('stl-1')!.calculationSnapshot as Row).netAmount = -0.01;
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT('x')),
    ).rejects.toThrow('execution_requires_positive_net');
  });

  it('Ch. 17.4 gate: execution refuses when the platform gates are not attested', async () => {
    delete process.env[GATES_ENV];
    try {
      const w = world();
      await expect(
        w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT('x')),
      ).rejects.toThrow('financial_gates_not_attested');
    } finally {
      process.env[GATES_ENV] = 'true';
    }
  });

  it('RULE 5: possession of the hash is NOT a preview — execution demands the RECORDED act', async () => {
    const w = world();
    // The approver obtains the hash WITHOUT previewing — computed
    // straight off the frozen snapshot. No preview act is recorded.
    const calculationHash = hashCalc(
      w.batches.get('stl-1')!.calculationSnapshot as never,
    );
    await w.exec.approve('finance-2', 'stl-1', { calculationHash });
    await expect(
      w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(calculationHash)),
    ).rejects.toThrow('preview_act_required');
  });

  it('§32.3 defense: a backdated bank value date cannot ride the routine lane', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    await expect(
      w.exec.execute('proposer-1', 'stl-1', {
        previewHash: p.calculationHash,
        bankTransferReference: 'BANK-OUT-7001',
        executedAt: '2026-07-10T08:00:00.000Z', // 12 days back
      }),
    ).rejects.toThrow('remittance_executed_at_out_of_window');
  });

  it('§18.2 crash resume: a settled batch completes its chain WITHOUT re-proving lapsed approvals (review finding 1)', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    await w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash));
    // Simulate the crash AFTER the atomic settle, BEFORE posting +
    // statement: strip the tail artifacts, keep batch settled +
    // remittance row (the only state the atomicity permits).
    w.ledgerRows.length = 0;
    w.statements.length = 0;
    // Days later — approvals AND preview acts all lapsed.
    w.clockState.now = new Date('2026-07-30T09:00:00.000Z');
    const healed = await w.exec.execute(
      'proposer-1',
      'stl-1',
      EXEC_INPUT(p.calculationHash),
    );
    expect(
      w.ledgerRows.find((r) => r.eventType === 'merchant.remittance.paid'),
    ).toBeTruthy();
    expect(w.statements).toHaveLength(1);
    expect((healed.remittance as Row).amount).toBe(5750);
    // The heal is AUDITED (§33.4 — the completion appears in the trail).
    expect(
      w.auditRows.find((a) => a.action === 'settlement.execution.healed'),
    ).toBeTruthy();
    // ...but different evidence on the heal lane still conflicts.
    await expect(
      w.exec.execute('proposer-1', 'stl-1', {
        ...EXEC_INPUT(p.calculationHash),
        bankTransferReference: 'BANK-OUT-9999',
      }),
    ).rejects.toThrow('remittance_conflict');
  });

  it('ANTI-DOUBLE-PAY: a batch with a recorded remittance can never be superseded (review finding 2)', async () => {
    const w = world();
    // Construct the guarded-against state directly: ready batch +
    // remittance row (impossible under the atomicity, but the law
    // must hold even against repair-path mistakes).
    w.remittances.push({
      id: 'rem-x',
      settlementId: 'stl-1',
      settlementReference: 'QS-TEST-0001',
      storeId: 's-1',
      currency: 'SAR',
      amount: 5750,
      bankTransferReference: 'BANK-OUT-7001',
      executedAt: new Date('2026-07-22T08:45:00.000Z'),
      executedBy: 'proposer-1',
    });
    await expect(
      w.engine.supersede('ops-1', 'stl-1', 'withdrawn'),
    ).rejects.toThrow('supersede_refused_remittance_exists');
    // And a lawfully SETTLED batch is terminal anyway.
  });

  it('HARDENING: the stored record carries the canonical bytes; hash = sha256(canonical); retrieval verifies integrity BEFORE rendering', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    await w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash));
    const stored = w.statements[0];
    // Req. 1+2: the canonical string IS the payload's canonical form,
    // and the hash derives from those bytes only.
    expect(stored.canonicalJson).toBe(canonicalJson(stored.payload));
    expect(stored.statementHash).toBe(
      hashCanonical(stored.canonicalJson as string),
    );
    // Retrieval exposes canonical bytes + (empty) signature envelopes.
    const doc = await w.exec.statement('stl-1');
    expect((doc as Row).canonicalJson).toBe(stored.canonicalJson);
    expect((doc as Row).signatures).toEqual([]);
    // Req. 5: tampering ANY representation refuses rendering.
    (stored.payload as Row).netAmount = 999;
    await expect(w.exec.statement('stl-1')).rejects.toThrow(
      'statement_integrity_violation',
    );
  });

  it('HARDENING: replay verifies integrity FIRST, persists the run with its engine version', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    await w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash));
    const clean = await w.exec.replay('finance-2', 'stl-1');
    expect(clean.replayEngineVersion).toBe('settle2-replay@v1');
    expect(clean.statementIntegrityVerified).toBe(true);
    expect(clean.statementIdentical).toBe(true);
    // The run is a RECORDED act (append-only) with the version.
    expect(w.replayRecords).toHaveLength(1);
    expect(w.replayRecords[0]).toMatchObject({
      replayEngineVersion: 'settle2-replay@v1',
      statementIntegrityVerified: true,
      statementIdentical: true,
      ranBy: 'finance-2',
    });
    // Tamper the STORED canonical bytes: integrity fails BEFORE any
    // comparison; the regenerated statement (frozen data) is still
    // returned as the trustworthy rendering.
    w.statements[0].canonicalJson = '{"tampered":true}';
    const dirty = await w.exec.replay('finance-2', 'stl-1');
    expect(dirty.statementIntegrityVerified).toBe(false);
    expect(dirty.statementIdentical).toBe(false);
    expect((dirty.statement as Row).netAmount).toBe(5750); // regenerated, trustworthy
    expect(w.replayRecords).toHaveLength(2);
    expect(w.replayRecords[1]).toMatchObject({
      statementIntegrityVerified: false,
    });
  });

  it('§34 replay harness: the stored statement regenerates identically; tampering surfaces', async () => {
    const w = world();
    const p = await w.exec.preview('finance-2', 'stl-1');
    await w.exec.approve('finance-2', 'stl-1', {
      calculationHash: p.calculationHash,
    });
    await w.exec.execute('proposer-1', 'stl-1', EXEC_INPUT(p.calculationHash));
    const report = await w.exec.replay('finance-2', 'stl-1');
    expect(report.calculationReplayVerified).toBe(true);
    expect(report.statementIdentical).toBe(true);
    expect(report.regeneratedStatementHash).toBe(report.storedStatementHash);
    // Tamper the stored hash — replay must surface the divergence.
    w.statements[0].statementHash = 'tampered';
    const bad = await w.exec.replay('finance-2', 'stl-1');
    expect(bad.statementIdentical).toBe(false);
    // Before issuance, replay has nothing to check against.
    const w2 = world();
    await expect(w2.exec.replay('finance-2', 'stl-1')).rejects.toThrow(
      'statement_not_issued',
    );
  });
});
