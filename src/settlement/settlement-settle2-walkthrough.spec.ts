// Track C PR 3 — the MANDATED end-to-end financial walkthrough,
// executable. SETTLE-2 closes the S01 chain: the assembled batch is
// previewed, approved (maker–checker), executed (separated executor),
// the payable EXTINGUISHES, the statement issues, and §34 replay
// regenerates it identically.
//
//   Business event → Ledger before → Ledger entries created →
//   References → Receivable/Payable changes → Settlement state →
//   Audit records → Ledger after (+ §34 replay).
//
// Story (S01): Dar Alteeb's 5,750.00 goods payable sits eligible after
// SETTLE-1's receipts. Finance (founder-finance) assembles the batch
// (QS born, proposer recorded), previews the execution, the SECOND
// finance seat approves against the frozen calculation hash, the
// proposer executes the bank transfer (lawful preparer-execution,
// §33.2), records the remittance evidence, the batch settles with its
// completed marker, the Settlement Statement issues carrying QS + the
// merchant's legal number + the QB, and replay proves the whole record
// regenerates byte-identically.

import { SettlementEngineService } from './settlement-engine.service';
import { SettlementExecutionService } from './settlement-execution.service';
import { statementHash } from './settlement-statement';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';

describe('Track C PR 3 — end-to-end financial walkthrough (S01: assembly → approval → execution → statement → §34 replay)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('walks the full chain to the extinguished payable and the replay-identical statement', async () => {
    // ── STAGE 0: Business event ─────────────────────────────────────
    // SETTLE-1 finished: goods invoice DAT-2026-0042 fully paid via
    // receipts, payable 5,750.00 accrued, item ELIGIBLE.
    const REFERENCES = {
      campaign: 'QB-N4CD-8GVW',
      merchantInvoiceNumber: 'DAT-2026-0042',
    };
    const ledgerRows: Row[] = [
      {
        eventType: 'merchant.payable.accrued',
        amount: 2000,
        currency: 'SAR',
        direction: 'debit',
        storeId: 's-daralteeb',
        idempotencyKey: 'merchant.payable.accrued:rcpt-1',
      },
      {
        eventType: 'merchant.payable.accrued',
        amount: 3750,
        currency: 'SAR',
        direction: 'debit',
        storeId: 's-daralteeb',
        idempotencyKey: 'merchant.payable.accrued:rcpt-2',
      },
    ];
    let seq = 0;
    const items: Row[] = [
      {
        id: 'sitem-1',
        occurrenceType: 'merchant_invoice',
        occurrenceId: 'minv-1',
        storeId: 's-daralteeb',
        currency: 'SAR',
        amount: 5750,
        state: 'eligible',
        batchId: null,
        createdAt: new Date('2026-07-21T10:00:00.000Z'),
      },
    ];
    const batches = new Map<string, Row>();
    const approvals: Row[] = [];
    const previewActs: Row[] = [];
    const remittances: Row[] = [];
    const statements: Row[] = [];
    const replayRecords: Row[] = [];
    const auditRows: Row[] = [];

    const prisma = {
      merchantInvoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'minv-1',
            merchantInvoiceNumber: REFERENCES.merchantInvoiceNumber,
            campaignId: 'camp-eid',
          },
        ]),
      },
      giftCampaign: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'camp-eid', referenceNumber: REFERENCES.campaign },
          ]),
      },
      settlementItem: {
        findMany: jest.fn().mockImplementation(({ where }: never) => {
          const w = where as Row;
          return Promise.resolve(
            items.filter(
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
                typeof w.id === 'string'
                  ? [w.id]
                  : (w.id as { in: string[] }).in;
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
      settlementReceivable: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      settlementBatch: {
        // §32.3 zero-net aggregate seam (Lane 2 PR 2) — this world
        // closes by remittance only; no zero-net rows exist.
        findMany: jest.fn().mockImplementation(({ where }: never) => {
          const w = where as { closureType?: string };
          return Promise.resolve(
            [...batches.values()].filter(
              (b) =>
                w.closureType === undefined ||
                b.closureType === w.closureType,
            ),
          );
        }),
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
          previewActs.push(row);
          return Promise.resolve(row);
        }),
        findMany: jest
          .fn()
          .mockImplementation(() => Promise.resolve(previewActs)),
      },
      settlementApproval: {
        create: jest.fn().mockImplementation(({ data }: never) => {
          const row = { id: `apr-${++seq}`, ...(data as Row) };
          approvals.push(row);
          return Promise.resolve(row);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(approvals)),
      },
      settlementRemittance: {
        create: jest.fn().mockImplementation(({ data }: never) => {
          const row = { id: `rem-${++seq}`, ...(data as Row) };
          remittances.push(row);
          return Promise.resolve(row);
        }),
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(remittances[0] ?? null)),
        findMany: jest.fn().mockResolvedValue([]),
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
          const row = { id: `stmt-${++seq}`, ...(data as Row) };
          statements.push(row);
          return Promise.resolve(row);
        }),
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(statements[0] ?? null)),
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
    const clock = { now: () => new Date('2026-07-22T09:00:00.000Z') };
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

    // ── STAGE 1: Ledger BEFORE ──────────────────────────────────────
    // Signed payable position (§11.4): accrued 5,750 − remitted 0.
    const payablePosition = () =>
      ledgerRows
        .filter((e) => e.eventType === 'merchant.payable.accrued')
        .reduce((s, e) => s + (e.amount as number), 0) -
      ledgerRows
        .filter((e) => e.eventType === 'merchant.remittance.paid')
        .reduce((s, e) => s + (e.amount as number), 0);
    expect(payablePosition()).toBe(5750);

    // ── STAGE 2: Assembly — QS born, proposer recorded ──────────────
    const batch = await engine.assembleBatch('founder-finance', 's-daralteeb');
    const QS = batch.settlementReference as string;
    expect(QS).toMatch(/^QS-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(batch.assembledBy).toBe('founder-finance');
    // §15.1/RC 14.4: references frozen INTO the composition.
    expect(
      (batch.composition as Row[])[0].references,
    ).toEqual({
      merchantInvoiceNumber: 'DAT-2026-0042',
      campaignReference: 'QB-N4CD-8GVW',
    });

    // ── STAGE 3: Preview → Approval (maker–checker, §31.1 L2) ───────
    const preview = await exec.preview('finance-two', batch.id as string);
    expect(preview.replayVerified).toBe(true);
    expect(preview.netAmount).toBe(5750);
    // The proposer cannot approve their own batch.
    await expect(
      exec.approve('founder-finance', batch.id as string, {
        calculationHash: preview.calculationHash,
      }),
    ).rejects.toThrow('approver_cannot_be_proposer');
    const approval = await exec.approve('finance-two', batch.id as string, {
      calculationHash: preview.calculationHash,
    });
    expect(approval.requirement.level).toBe(2); // 5,750 → L2 band

    // ── STAGE 4: Execute — the separated act (§33) ──────────────────
    // Proposer executes (lawful); the approver could NOT have.
    const result = await exec.execute('founder-finance', batch.id as string, {
      previewHash: preview.calculationHash,
      bankTransferReference: 'BANK-OUT-7001',
      executedAt: '2026-07-22T08:45:00.000Z',
    });

    // Ledger entries created: the remittance (money OUT of
    // safeguarding to the merchant bank) + the zero-amount completed
    // marker, both occurrence-anchored.
    const remitted = ledgerRows.find(
      (e) => e.eventType === 'merchant.remittance.paid',
    )!;
    expect(remitted).toMatchObject({
      amount: 5750,
      direction: 'credit',
      idempotencyKey: `merchant.remittance.paid:${
        (result.remittance as Row).id
      }`,
    });
    expect((remitted.metadata as Row).account).toBe('safeguarding');
    const completed = ledgerRows.find(
      (e) => e.eventType === 'settlement.completed',
    )!;
    expect(completed).toMatchObject({
      amount: 0,
      idempotencyKey: `settlement.completed:${batch.id}`,
    });

    // ── STAGE 5: Receivable / Payable changes ───────────────────────
    // The payable EXTINGUISHED: 5,750 accrued − 5,750 remitted = 0.
    expect(payablePosition()).toBe(0);

    // ── STAGE 6: Settlement state ───────────────────────────────────
    expect(batches.get(batch.id as string)!.status).toBe('settled');
    expect(items[0].state).toBe('settled');

    // ── STAGE 7: References + the Settlement Statement ──────────────
    const stmt = statements[0];
    const payload = stmt.payload as Row;
    expect(payload.settlementReference).toBe(QS);
    expect(payload.netAmount).toBe(5750);
    expect((payload.coveredOccurrences as Row[])[0].references).toEqual({
      merchantInvoiceNumber: 'DAT-2026-0042', // SUPPLIED, never manufactured
      campaignReference: 'QB-N4CD-8GVW',
    });
    expect((payload.remittance as Row).bankTransferReference).toBe(
      'BANK-OUT-7001',
    );
    expect(stmt.statementHash).toBe(statementHash(payload as never));

    // ── STAGE 8: Audit records — the §33.4 separation proof ─────────
    const actions = auditRows.map((a) => a.action);
    expect(actions).toEqual([
      'settlement.batch.assembled',
      'settlement.execution.previewed',
      'settlement.execution.approved',
      'settlement.batch.settled',
      'settlement.batch.executed',
    ]);
    const executedAudit = auditRows[auditRows.length - 1];
    expect(executedAudit.metadata).toMatchObject({
      proposer: 'founder-finance',
      approvedBy: ['finance-two'],
      executedBy: 'founder-finance',
      settlementReference: QS,
    });

    // ── Ledger AFTER + §34 replay ───────────────────────────────────
    const replayReport = await exec.replay('finance-two', batch.id as string);
    expect(replayReport.calculationReplayVerified).toBe(true);
    expect(replayReport.statementIdentical).toBe(true);
    expect(replayReport.regeneratedStatementHash).toBe(stmt.statementHash);
  });
});
