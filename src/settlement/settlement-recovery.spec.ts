// SETTLE-3b — §7.4 receivable recovery (Track C PR 7), unit pins +
// the MANDATED end-to-end walkthrough closing SC §25.2:
//
//   "next batch QS-B: gross … − receivable recovery … = net
//    receivable extinguished by offset. Net position dipped negative,
//    recovered."
//
// Covered: deterministic offset planning (oldest-first, gross-capped),
// frozen allocation (§34 replay recomputes WITH it), guarded staging
// (double-staging impossible; the amount-pin discipline), supersession
// release, consumption at execution inside the markSettled atomicity
// (lifecycle law + per-(receivable,batch) recovery postings), and the
// RC v3.0 credit-note statement attachment as a new document version.

import { SettlementEngineService } from './settlement-engine.service';
import { SettlementExecutionService } from './settlement-execution.service';
import { calculateSettlement } from './settlement-calculator';
import { creditNoteCanonical, creditNoteHash } from './settlement-credit-note';
import type { CreditNoteFacts } from './settlement-credit-note';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const T0 = '2026-07-23T09:00:00.000Z';

function world(opts?: { receivables?: Row[] }) {
  let seq = 0;
  const items: Row[] = [
    {
      id: 'i-2',
      occurrenceType: 'merchant_invoice',
      occurrenceId: 'minv-2',
      storeId: 's-1',
      currency: 'SAR',
      amount: 4600,
      state: 'eligible',
      batchId: null,
      createdAt: new Date('2026-07-23T08:00:00.000Z'),
    },
  ];
  const receivables: Row[] = opts?.receivables ?? [
    {
      id: 'rcv-1',
      storeId: 's-1',
      currency: 'SAR',
      amount: 1150,
      amountRecovered: 0,
      occurrenceType: 'refund',
      occurrenceId: 'ref-1',
      state: 'open',
      stagedBySettlementId: null,
      accruedAt: new Date('2026-07-22T12:00:00.000Z'),
    },
  ];
  const noteFacts: CreditNoteFacts = {
    referenceNumber: 'QN-K3MP-8WX2',
    refundId: 'ref-1',
    noteType: 'merchant_goods',
    invoiceType: 'merchant_invoice',
    invoiceId: 'minv-1',
    merchantInvoiceNumber: 'DAT-2026-0042',
    merchantCreditNoteNumber: null,
    issuerType: 'MERCHANT',
    issuanceSource: 'MERCHANT',
    onBehalfAuthorizationRef: null,
    creditNoteUuid: null,
    originalInvoiceNumber: 'DAT-2026-0042',
    storeId: 's-1',
    orgId: 'org-1',
    campaignId: 'camp-1',
    currency: 'SAR',
    amount: 1150,
    vatComponent: 150,
    reason: 'two units damaged',
    issuedAt: '2026-07-22T12:00:00.000Z',
    issuedBy: 'fin-1',
    statementSettlementId: null,
  };
  const noteVersions: Row[] = [];
  const creditNotes: Row[] = [
    {
      id: 'cn-1',
      ...noteFacts,
      issuedAt: new Date(noteFacts.issuedAt),
      canonicalJson: creditNoteCanonical(noteFacts),
      documentHash: creditNoteHash(noteFacts),
      currentVersion: 1,
    },
  ];
  noteVersions.push({
    id: 'cnv-1',
    creditNoteId: 'cn-1',
    versionNumber: 1,
    changeReason: 'issued',
    canonicalJson: creditNoteCanonical(noteFacts),
    documentHash: creditNoteHash(noteFacts),
    statementSettlementId: null,
    createdBy: 'fin-1',
  });
  const batches = new Map<string, Row>();
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
    settlementReceivable: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as Row;
        return Promise.resolve(
          receivables
            .map((r) => ({ ...r }))
            .filter(
              (r) =>
                (w.storeId === undefined || r.storeId === w.storeId) &&
                (w.currency === undefined || r.currency === w.currency) &&
                (w.state === undefined ||
                  (w.state as { in: string[] }).in.includes(
                    r.state as string,
                  )) &&
                (w.stagedBySettlementId === undefined ||
                  r.stagedBySettlementId === w.stagedBySettlementId),
            ),
        );
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) =>
        Promise.resolve(
          receivables.find((r) => r.id === (where as Row).id) ?? null,
        ),
      ),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        let count = 0;
        for (const r of receivables) {
          if (w.id !== undefined && r.id !== w.id) continue;
          if (
            w.state !== undefined &&
            typeof w.state === 'object' &&
            !(w.state as { in: string[] }).in.includes(r.state as string)
          )
            continue;
          if (
            w.state !== undefined &&
            typeof w.state === 'string' &&
            r.state !== w.state
          )
            continue;
          if (
            w.stagedBySettlementId !== undefined &&
            r.stagedBySettlementId !== w.stagedBySettlementId
          )
            continue;
          if (w.amountRecovered !== undefined && r.amountRecovered !== w.amountRecovered)
            continue;
          Object.assign(r, data as Row);
          count++;
        }
        return Promise.resolve({ count });
      }),
    },
    settlementItem: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as Row;
        return Promise.resolve(
          items
            .map((i) => ({ ...i }))
            .filter(
              (i) =>
                (w.storeId === undefined || i.storeId === w.storeId) &&
                (w.state === undefined || i.state === w.state) &&
                (w.batchId === undefined || i.batchId === w.batchId) &&
                (w.currency === undefined || i.currency === w.currency),
            ),
        );
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as {
          id?: string | { in: string[] };
          batchId?: string | null;
          state?: string;
          amount?: unknown;
        };
        let count = 0;
        for (const i of items) {
          if (w.id !== undefined) {
            const ids =
              typeof w.id === 'string' ? [w.id] : (w.id as { in: string[] }).in;
            if (!ids.includes(i.id as string)) continue;
          }
          if (w.batchId !== undefined && i.batchId !== w.batchId) continue;
          if (w.state !== undefined && i.state !== w.state) continue;
          if (w.amount !== undefined && i.amount !== w.amount) continue;
          Object.assign(i, data as Row);
          count++;
        }
        return Promise.resolve({ count });
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
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `stl-${++seq}`, ...(data as Row) };
        batches.set(row.id as string, row);
        return Promise.resolve(row);
      }),
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
    settlementExecutionPreview: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `prev-${++seq}`, ...(data as Row) };
        previews.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn().mockImplementation(() => Promise.resolve(previews)),
    },
    settlementApproval: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `apr-${++seq}`, ...(data as Row) };
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
        const row = {
          id: `rem-${++seq}`,
          createdAt: new Date(clockState.now),
          ...(data as Row),
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
      findMany: jest.fn().mockResolvedValue([]),
    },
    settlementStatementRecord: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `stmt-${++seq}`, ...(data as Row) };
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
    creditNoteVersion: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `cnv-${++seq}`, ...(data as Row) };
        noteVersions.push(row);
        return Promise.resolve(row);
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) =>
        Promise.resolve(
          noteVersions.filter(
            (v) => v.creditNoteId === (where as Row).creditNoteId,
          ),
        ),
      ),
    },
    creditNote: {
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { refundId?: string; referenceNumber?: string };
        const found = creditNotes.find(
          (c) =>
            (w.refundId !== undefined && c.refundId === w.refundId) ||
            (w.referenceNumber !== undefined &&
              c.referenceNumber === w.referenceNumber),
        );
        // SNAPSHOT COPY (DB reality): later mutations must not
        // retroactively change what a caller already read.
        return Promise.resolve(found ? { ...found } : null);
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        let count = 0;
        for (const c of creditNotes) {
          if (w.refundId !== undefined && c.refundId !== w.refundId) continue;
          if (
            w.statementSettlementId !== undefined &&
            c.statementSettlementId !== w.statementSettlementId
          )
            continue;
          Object.assign(c, data as Row);
          count++;
        }
        return Promise.resolve({ count });
      }),
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
  const ledgerRowsStore = ledgerRows;
  const ledger = {
    record: jest.fn().mockImplementation((row: Row) => {
      const existing = ledgerRowsStore.find(
        (r) => r.idempotencyKey === row.idempotencyKey,
      );
      if (existing) return Promise.resolve(existing);
      ledgerRowsStore.push(row);
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
    engine,
    exec,
    prisma,
    items,
    receivables,
    creditNotes,
    noteVersions,
    batches,
    remittances,
    statements,
    ledgerRows,
    auditRows,
  };
}

describe('SETTLE-3b — §7.4 receivable recovery', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('simulate runs the ONE calculator WITH the recovery line and exposes the prospective allocation', async () => {
    const w = world();
    const sim = await w.engine.simulate('fin-1', 's-1');
    expect(sim.calculation!.lines.receivableRecovery).toBe(1150);
    expect(sim.calculation!.netAmount).toBe(3450); // 4,600 − 1,150
    expect(sim.recoveryAllocation).toEqual([
      {
        receivableId: 'rcv-1',
        occurrenceId: 'ref-1',
        amount: 1150,
        amountRecoveredAtPlan: 0,
        balanceAfter: 0,
      },
    ]);
    // Simulation stages NOTHING (§30 side-effect-free).
    expect(w.receivables[0].stagedBySettlementId).toBeNull();
  });

  it('recovery is CAPPED at the batch gross — offset never drives the net negative', async () => {
    const w = world({
      receivables: [
        {
          id: 'rcv-big',
          storeId: 's-1',
          currency: 'SAR',
          amount: 9999,
          amountRecovered: 0,
          occurrenceType: 'refund',
          occurrenceId: 'ref-big',
          state: 'open',
          stagedBySettlementId: null,
          accruedAt: new Date('2026-07-22T12:00:00.000Z'),
        },
      ],
    });
    const sim = await w.engine.simulate('fin-1', 's-1');
    expect(sim.calculation!.lines.receivableRecovery).toBe(4600); // capped
    expect(sim.calculation!.netAmount).toBe(0);
    expect(sim.recoveryAllocation![0]).toMatchObject({
      amount: 4600,
      balanceAfter: 5399, // 9,999 − 4,600 rolls forward
    });
  });

  it('assembly FREEZES the allocation and STAGES the receivable under guard; §34 preview verifies WITH it', async () => {
    const w = world();
    const batch = await w.engine.assembleBatch('proposer-1', 's-1');
    expect(batch.recoveryAllocation).toEqual([
      {
        receivableId: 'rcv-1',
        occurrenceId: 'ref-1',
        amount: 1150,
        amountRecoveredAtPlan: 0,
        balanceAfter: 0,
      },
    ]);
    expect(batch.netAmount).toBe(3450);
    expect(w.receivables[0].stagedBySettlementId).toBe(batch.id);
    // §34: the frozen snapshot replays WITH the frozen adjustments.
    const preview = await w.exec.preview('finance-2', batch.id as string);
    expect(preview.replayVerified).toBe(true);
    expect(preview.netAmount).toBe(3450);
  });

  it('a receivable staged by a racing batch fails the guard and the WHOLE assembly rolls back', async () => {
    const w = world();
    w.receivables[0].stagedBySettlementId = 'stl-racer';
    // planRecovery excludes staged rows → no recovery line, clean 4,600
    // batch instead (the racer owns the offset). Nothing contends.
    const batch = await w.engine.assembleBatch('proposer-1', 's-1');
    expect(batch.netAmount).toBe(4600);
    expect(batch.recoveryAllocation).toEqual([]);
    // But a stage-vs-recovery race INSIDE the window (allocation
    // planned, then recovered amount moved) must roll back:
    const w2 = world();
    const origCreate = w2.prisma.settlementBatch.create.getMockImplementation()!;
    w2.prisma.settlementBatch.create.mockImplementationOnce((args: never) => {
      w2.receivables[0].amountRecovered = 500; // §7.4 moved concurrently
      return origCreate(args);
    });
    await expect(w2.engine.assembleBatch('proposer-1', 's-1')).rejects.toThrow(
      'settlement_receivables_contended',
    );
  });

  it('review finding 1: a zero-net plan REFUSES at assembly — no approvable-unexecutable batch can be minted', async () => {
    const w = world({
      receivables: [
        {
          id: 'rcv-eq',
          storeId: 's-1',
          currency: 'SAR',
          amount: 4600, // equals the eligible gross → net would be 0
          amountRecovered: 0,
          occurrenceType: 'refund',
          occurrenceId: 'ref-eq',
          state: 'open',
          stagedBySettlementId: null,
          accruedAt: new Date('2026-07-22T12:00:00.000Z'),
        },
      ],
    });
    // Simulate still shows the honest zero-net picture (§26)...
    const sim = await w.engine.simulate('fin-1', 's-1');
    expect(sim.calculation!.netAmount).toBe(0);
    // ...but assembly refuses until the statement-only close lane ships.
    await expect(w.engine.assembleBatch('proposer-1', 's-1')).rejects.toThrow(
      'settlement_zero_net_deferred',
    );
    expect(w.receivables[0].stagedBySettlementId).toBeNull(); // nothing staged
    expect(w.batches.size).toBe(0);
  });

  it('review finding 2: a partial roll-forward CONSUMES without a state transition — the second partial batch never wedges', async () => {
    // Construct the future-lane state directly: a receivable already
    // partially recovered (500 of 1,150) staged by this batch, whose
    // frozen allocation takes another 300 (balance 350 remains).
    const w = world({
      receivables: [
        {
          id: 'rcv-part',
          storeId: 's-1',
          currency: 'SAR',
          amount: 1150,
          amountRecovered: 500,
          occurrenceType: 'refund',
          occurrenceId: 'ref-1',
          state: 'partially_recovered',
          stagedBySettlementId: 'stl-manual',
          accruedAt: new Date('2026-07-22T12:00:00.000Z'),
        },
      ],
    });
    w.batches.set('stl-manual', {
      id: 'stl-manual',
      settlementReference: 'QS-PART-0001',
      storeId: 's-1',
      currency: 'SAR',
      status: 'ready',
      windowType: 'manual',
      grossAmount: 4600,
      netAmount: 4300,
      composition: [
        {
          itemId: 'i-2',
          occurrenceType: 'merchant_invoice',
          occurrenceId: 'minv-2',
          amount: 4600,
          currency: 'SAR',
          references: {},
        },
      ],
      calculationSnapshot: calculateSettlement(
        [
          {
            itemId: 'i-2',
            occurrenceType: 'merchant_invoice',
            occurrenceId: 'minv-2',
            amount: 4600,
            currency: 'SAR',
          },
        ],
        { receivableRecovery: 300 },
      ),
      recoveryAllocation: [
        {
          receivableId: 'rcv-part',
          occurrenceId: 'ref-1',
          amount: 300,
          amountRecoveredAtPlan: 500,
          balanceAfter: 350,
        },
      ],
      assembledBy: 'proposer-1',
    });
    w.items[0].state = 'ready';
    w.items[0].batchId = 'stl-manual';
    const res = await w.engine.markSettled('exec-1', 'stl-manual', {
      bankTransferReference: 'BANK-OUT-9001',
      executedAt: new Date('2026-07-23T08:00:00.000Z'),
      executedBy: 'exec-1',
    });
    expect(res.replayed).toBe(false);
    // Same-state roll-forward: no transition asserted, amount advances.
    expect(w.receivables[0]).toMatchObject({
      state: 'partially_recovered',
      amountRecovered: 800,
      stagedBySettlementId: null,
    });
    // ...and the consume AMOUNT PIN (finding 4): a moved recovered-so-
    // far rolls the settle back.
    const w2 = world({
      receivables: [
        {
          id: 'rcv-part',
          storeId: 's-1',
          currency: 'SAR',
          amount: 1150,
          amountRecovered: 999, // ≠ at-plan 500 — a future writer moved it
          occurrenceType: 'refund',
          occurrenceId: 'ref-1',
          state: 'partially_recovered',
          stagedBySettlementId: 'stl-manual',
          accruedAt: new Date('2026-07-22T12:00:00.000Z'),
        },
      ],
    });
    w2.batches.set('stl-manual', {
      ...w.batches.get('stl-manual')!,
      status: 'ready',
    });
    w2.items[0].state = 'ready';
    w2.items[0].batchId = 'stl-manual';
    await expect(
      w2.engine.markSettled('exec-1', 'stl-manual', {
        bankTransferReference: 'BANK-OUT-9002',
        executedAt: new Date('2026-07-23T08:00:00.000Z'),
        executedBy: 'exec-1',
      }),
    ).rejects.toThrow('settlement_receivables_contended');
  });

  it('supersession RELEASES staged receivables to the successor queue', async () => {
    const w = world();
    const batch = await w.engine.assembleBatch('proposer-1', 's-1');
    expect(w.receivables[0].stagedBySettlementId).toBe(batch.id);
    await w.engine.supersede('ops-1', batch.id as string, 'withdrawn');
    expect(w.receivables[0].stagedBySettlementId).toBeNull();
    expect(w.receivables[0].state).toBe('open'); // untouched lifecycle
  });

  it('WALKTHROUGH (§25.2 close): assemble QS-B → approve → execute → receivable extinguished by offset, statement enumerates, credit note attached', async () => {
    // ── Business event: Dar Alteeb's next campaign settled 4,600 while
    // owing 1,150 from the SETTLE-3a clawback (receivable OPEN).
    const w = world();
    // Ledger BEFORE (§25.2): position dipped negative by the accrual.
    w.ledgerRows.push(
      {
        eventType: 'merchant.payable.accrued',
        amount: 4600,
        direction: 'debit',
        idempotencyKey: 'merchant.payable.accrued:rcpt-x',
      },
      {
        eventType: 'merchant.receivable.accrued',
        amount: 1150,
        direction: 'credit',
        idempotencyKey: 'merchant.receivable.accrued:ref-1',
      },
    );
    // §11.4 / FC v1.0.1 Ch. 6.4 (the merchant-position form):
    //   payables − remittances − recoveries − outstanding receivables
    // (recovery satisfies part of the payable by OFFSET — it is its
    // own subtraction, and it simultaneously extinguishes the
    // receivable it recovers).
    const sum = (ev: string) =>
      w.ledgerRows
        .filter((e) => e.eventType === ev)
        .reduce((s, e) => s + (e.amount as number), 0);
    const position = () =>
      sum('merchant.payable.accrued') -
      sum('merchant.remittance.paid') -
      sum('merchant.receivable.recovered') -
      (sum('merchant.receivable.accrued') -
        sum('merchant.receivable.recovered'));
    expect(position()).toBe(3450); // 4,600 payable − 1,150 owed back

    // ── Assemble QS-B: gross 4,600 − recovery 1,150 = net 3,450.
    const batch = await w.engine.assembleBatch('proposer-1', 's-1');
    const preview = await w.exec.preview('finance-2', batch.id as string);
    await w.exec.approve('finance-2', batch.id as string, {
      calculationHash: preview.calculationHash,
    });
    const res = await w.exec.execute('proposer-1', batch.id as string, {
      previewHash: preview.calculationHash,
      bankTransferReference: 'BANK-OUT-8001',
      executedAt: '2026-07-23T08:45:00.000Z',
    });

    // ── Ledger entries: remittance = the FROZEN net; recovery posting
    // keyed per (receivable, batch); completed marker.
    expect((res.remittance as Row).amount).toBe(3450);
    const recovered = w.ledgerRows.find(
      (e) => e.eventType === 'merchant.receivable.recovered',
    )!;
    expect(recovered).toMatchObject({
      amount: 1150,
      direction: 'debit',
      idempotencyKey: `merchant.receivable.recovered:rcv-1:${batch.id}`,
    });
    expect((recovered.metadata as Row)).toMatchObject({
      accountFrom: 'safeguarding',
      accountTo: 'operating',
    });

    // ── Receivable EXTINGUISHED by offset (§25.2's close).
    expect(w.receivables[0]).toMatchObject({
      state: 'recovered',
      amountRecovered: 1150,
      stagedBySettlementId: null,
      recoveredBySettlementId: batch.id,
    });
    expect(position()).toBe(0); // 4,600 − 3,450 − 1,150 − 0 = 0

    // ── Statement enumerates the §4 recovery line.
    const stmt = w.statements[0].payload as Row;
    expect((stmt.lines as Row).receivableRecovery).toBe(1150);
    expect(stmt.netAmount).toBe(3450);

    // ── RC v3.0: the credit note acquired its STATEMENT RELATIONSHIP
    // as a NEW document version — canonical + hash regenerated,
    // audited, write-once.
    const note = w.creditNotes[0];
    expect(note.statementSettlementId).toBe(batch.id);
    const factsNow: CreditNoteFacts = {
      referenceNumber: note.referenceNumber as string,
      refundId: note.refundId as string,
      noteType: note.noteType as string,
      invoiceType: note.invoiceType as string,
      invoiceId: note.invoiceId as string,
      merchantInvoiceNumber: note.merchantInvoiceNumber as string,
      merchantCreditNoteNumber: note.merchantCreditNoteNumber as string | null,
      issuerType: note.issuerType as string,
      issuanceSource: note.issuanceSource as string,
      onBehalfAuthorizationRef: note.onBehalfAuthorizationRef as string | null,
      creditNoteUuid: note.creditNoteUuid as string | null,
      originalInvoiceNumber: note.originalInvoiceNumber as string | null,
      storeId: note.storeId as string,
      orgId: note.orgId as string,
      campaignId: note.campaignId as string,
      currency: note.currency as string,
      amount: note.amount as number,
      vatComponent: note.vatComponent as number,
      reason: note.reason as string,
      issuedAt: (note.issuedAt as Date).toISOString(),
      issuedBy: note.issuedBy as string,
      statementSettlementId: batch.id as string,
    };
    expect(note.canonicalJson).toBe(creditNoteCanonical(factsNow));
    expect(note.documentHash).toBe(creditNoteHash(factsNow));
    expect(
      w.auditRows.find(
        (a) => a.action === 'settlement.credit_note.statement_attached',
      ),
    ).toBeTruthy();

    // ── PROOF 5 (founder legal check): attachment NEVER rewrote the
    // issued version — v1's bytes are preserved append-only; v2 is a
    // NEW version row; the head advanced its pointer.
    expect(note.currentVersion).toBe(2);
    expect(w.noteVersions).toHaveLength(2);
    const v1 = w.noteVersions[0];
    const factsV1 = { ...factsNow, statementSettlementId: null };
    expect(v1).toMatchObject({ versionNumber: 1, changeReason: 'issued' });
    expect(v1.canonicalJson).toBe(creditNoteCanonical(factsV1)); // untouched
    expect(v1.documentHash).toBe(creditNoteHash(factsV1));
    const v2 = w.noteVersions[1];
    expect(v2).toMatchObject({
      versionNumber: 2,
      changeReason: 'statement_attached',
      statementSettlementId: batch.id,
    });
    // ── PROOF 6: EVERY historical version reproduces byte-for-byte
    // from its recorded facts — v1 (pre-attachment) and v2 (attached).
    expect(v2.canonicalJson).toBe(creditNoteCanonical(factsNow));
    expect(v2.documentHash).toBe(creditNoteHash(factsNow));

    // ── §34: the settled batch replays identically WITH the frozen
    // allocation, years later.
    const replay = await w.exec.replay('finance-2', batch.id as string);
    expect(replay.calculationReplayVerified).toBe(true);
    expect(replay.statementIdentical).toBe(true);
    // And the calculator recomputes the same net from frozen data:
    expect(
      calculateSettlement(
        (batch.composition as Row[]).map((c) => ({
          itemId: c.itemId as string,
          occurrenceType: c.occurrenceType as string,
          occurrenceId: c.occurrenceId as string,
          amount: c.amount as number,
          currency: c.currency as string,
        })),
        { receivableRecovery: 1150 },
      ).netAmount,
    ).toBe(3450);
  });
});
