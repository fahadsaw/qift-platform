// Lane 2 PR 2 — SC §26 Zero-Net Statement-Only Close: the executable
// FINANCIAL WALKTHROUGH + the founder's mandated proofs.
//
// The narrative: goods money landed (payable 4,600), then the full
// amount was refunded post-settlement and fronted by Qift (receivable
// 4,600). The next batch's frozen net is EXACTLY ZERO — §26 closes it
// through a Settlement Statement with NO bank transfer, NO remittance,
// NO fabricated evidence; the statement is the sole instrument of
// closure. Preview → Approval → Close on the SAME frozen calculation
// and RULE 6 gate as bank execution.

import { SettlementEngineService } from './settlement-engine.service';
import { SettlementExecutionService } from './settlement-execution.service';
import { calculateSettlement } from './settlement-calculator';
import {
  canonicalJson,
  hashCanonical,
  ZERO_NET_NO_TRANSFER_TEXT,
} from './settlement-statement';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const T0 = '2026-07-24T09:00:00.000Z';

function world(opts?: { currency?: string; netDeltaMinorUnits?: number }) {
  const currency = opts?.currency ?? 'SAR';
  // Frozen state honestly constructed through the ONE calculator: a
  // gross of 4,600 fully offset by a 4,600 receivable recovery —
  // net EXACTLY zero. netDeltaMinorUnits shifts the gross by ±N minor
  // units to prove the exact-zero law (±0.01 is NOT zero).
  const delta = (opts?.netDeltaMinorUnits ?? 0) / 100;
  const gross = 4600 + delta;
  const snapshot = calculateSettlement(
    [
      {
        itemId: 'i-1',
        occurrenceType: 'merchant_invoice',
        occurrenceId: 'mi-1',
        amount: gross,
        currency,
      },
    ],
    { receivableRecovery: 4600 },
  );
  let seq = 0;
  const batches = new Map<string, Row>([
    [
      'stl-1',
      {
        id: 'stl-1',
        settlementReference: 'QS-ZERO-0001',
        storeId: 's-1',
        currency,
        status: 'ready',
        windowType: 'manual',
        grossAmount: gross,
        netAmount: snapshot.netAmount,
        composition: [
          {
            itemId: 'i-1',
            occurrenceType: 'merchant_invoice',
            occurrenceId: 'mi-1',
            amount: gross,
            currency,
            references: { merchantInvoiceNumber: 'DAT-2026-0042' },
          },
        ],
        calculationSnapshot: snapshot,
        recoveryAllocation: [
          {
            receivableId: 'rcv-1',
            occurrenceId: 'ref-1',
            amount: 4600,
            amountRecoveredAtPlan: 0,
            balanceAfter: delta > 0 ? 0 : 0,
          },
        ],
        assembledBy: 'proposer-1',
        closureType: null,
        closedAt: null,
      },
    ],
  ]);
  const items: Row[] = [
    { id: 'i-1', state: 'ready', batchId: 'stl-1', createdAt: new Date(T0) },
  ];
  const receivables: Row[] = [
    {
      id: 'rcv-1',
      storeId: 's-1',
      currency,
      amount: 4600,
      amountRecovered: 0,
      occurrenceType: 'refund',
      occurrenceId: 'ref-1',
      state: 'open',
      stagedBySettlementId: 'stl-1',
    },
  ];
  const creditNotes: Row[] = [
    {
      id: 'cn-1',
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
      qiftCreditNoteNumber: null,
      netComponent: null,
      reasonCode: null,
      taxRuleVersion: null,
      buyerSnapshot: null,
      issuerSnapshot: null,
      storeId: 's-1',
      orgId: 'org-1',
      campaignId: 'camp-1',
      currency,
      amount: 4600,
      vatComponent: 600,
      reason: 'goods returned after settlement',
      issuedAt: new Date('2026-07-23T10:00:00.000Z'),
      issuedBy: 'fin-1',
      statementSettlementId: null,
      currentVersion: 1,
    },
  ];
  const approvals: Row[] = [];
  const previews: Row[] = [];
  const remittances: Row[] = [];
  const statements: Row[] = [];
  const replayRecords: Row[] = [];
  const noteVersions: Row[] = [];
  const ledgerRows: Row[] = [];
  const auditRows: Row[] = [];
  const clockState = { now: new Date(T0) };

  const prisma = {
    settlementBatch: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: never) =>
          Promise.resolve(batches.get((where as Row).id as string) ?? null),
        ),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where ?? {}) as {
          closureType?: string;
          id?: { not: string };
        };
        return Promise.resolve(
          [...batches.values()].filter(
            (b) =>
              (w.closureType === undefined ||
                b.closureType === w.closureType) &&
              (w.id === undefined || b.id !== w.id.not),
          ),
        );
      }),
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
    settlementReceivable: {
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const found = receivables.find(
          (r) => r.id === (where as Row).id,
        );
        return Promise.resolve(found ? { state: found.state } : null);
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        const hits = receivables.filter(
          (r) =>
            r.id === w.id &&
            (w.stagedBySettlementId === undefined ||
              r.stagedBySettlementId === w.stagedBySettlementId) &&
            (w.state === undefined || r.state === w.state) &&
            (w.amountRecovered === undefined ||
              r.amountRecovered === w.amountRecovered),
        );
        for (const r of hits) Object.assign(r, data as Row);
        return Promise.resolve({ count: hits.length });
      }),
    },
    creditNote: {
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { refundId?: string };
        const found = creditNotes.find((c) => c.refundId === w.refundId);
        return Promise.resolve(found ? { ...found } : null);
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        const hits = creditNotes.filter(
          (c) =>
            c.refundId === w.refundId &&
            (w.statementSettlementId === undefined ||
              c.statementSettlementId === w.statementSettlementId),
        );
        for (const c of hits) Object.assign(c, data as Row);
        return Promise.resolve({ count: hits.length });
      }),
    },
    creditNoteVersion: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `cnv-${++seq}`, ...(data as Row) };
        noteVersions.push(row);
        return Promise.resolve(row);
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
        const row = { id: `rem-${++seq}`, ...(data as Row) };
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
      findMany: jest.fn().mockImplementation(() => Promise.resolve([])),
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
    receivables,
    creditNotes,
    noteVersions,
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

// The lawful path to an approved zero-net batch.
async function previewAndApprove(w: ReturnType<typeof world>) {
  const preview = await w.exec.preview('proposer-1', 'stl-1');
  await w.exec.approve('checker-1', 'stl-1', {
    calculationHash: preview.calculationHash,
  });
  return preview;
}

describe('SC §26 — Zero-Net Statement-Only Close (Lane 2 PR 2)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('WALKTHROUGH: payable 4,600 vs receivable 4,600 → frozen zero-net batch → preview → approval → statement-only close → no remittance, positions extinguished, replay-identical statement', async () => {
    const w = world();

    // Business event + ledger before: the batch is frozen with net
    // EXACTLY zero (gross 4,600 fully offset by the fronted-refund
    // receivable), QS minted, item bound, receivable staged.
    expect(w.batches.get('stl-1')!.netAmount).toBe(0);
    expect(w.ledgerRows).toHaveLength(0);

    // Preview (recorded act) → approval (checker ≠ proposer).
    const preview = await previewAndApprove(w);
    expect(preview.replayVerified).toBe(true);

    // The §26 close — NO bank evidence in the input, by API shape.
    const res = await w.exec.closeZeroNet('closer-1', 'stl-1', {
      previewHash: preview.calculationHash,
    });
    expect(res.closureType).toBe('zero_net_no_transfer');

    // NO remittance, NO bank movement, NO fabricated evidence.
    expect(w.remittances).toHaveLength(0);
    expect(
      w.ledgerRows.find((r) => r.eventType === 'merchant.remittance.paid'),
    ).toBeUndefined();
    // Ledger after: ONLY the position extinguishment + the zero-amount
    // lifecycle marker — and neither claims cash moved.
    expect(w.ledgerRows.map((r) => r.eventType).sort()).toEqual([
      'merchant.receivable.recovered',
      'settlement.completed',
    ]);
    const recovery = w.ledgerRows.find(
      (r) => r.eventType === 'merchant.receivable.recovered',
    )!;
    const recMeta = recovery.metadata as Row;
    expect(recMeta.accountFrom).toBeUndefined(); // no cash claim
    expect(recMeta.accountTo).toBeUndefined();
    expect(recMeta.closureType).toBe('zero_net_no_transfer');
    expect(recMeta.internalTransferDue).toBe(true);
    const marker = w.ledgerRows.find(
      (r) => r.eventType === 'settlement.completed',
    )!;
    expect(marker.amount).toBe(0);
    expect((marker.metadata as Row).bankTransferReference).toBeUndefined();

    // Positions closed atomically: batch settled (closureType stamped
    // with the terminal transition), item settled, receivable fully
    // recovered — the signed merchant position reconciles to zero.
    const batch = w.batches.get('stl-1')!;
    expect(batch.status).toBe('settled');
    expect(batch.closureType).toBe('zero_net_no_transfer');
    expect(batch.closedAt).toBeInstanceOf(Date);
    expect(w.items[0].state).toBe('settled');
    expect(w.receivables[0].state).toBe('recovered');
    expect(w.receivables[0].amountRecovered).toBe(4600);
    expect(w.receivables[0].stagedBySettlementId).toBeNull();

    // The STATEMENT is the legal instrument: QS, merchant, currency,
    // opening position, lines, net 0, closure type, explicit
    // no-transfer text, canonical refs, canonical JSON + hash.
    expect(w.statements).toHaveLength(1);
    const stmt = w.statements[0];
    const payload = stmt.payload as Row;
    expect(payload.statementVersion).toBe('v2');
    expect(payload.settlementReference).toBe('QS-ZERO-0001');
    expect(payload.netAmount).toBe(0);
    expect(payload.remittance).toBeNull();
    const closure = payload.closure as Row;
    expect(closure.closureType).toBe('ZERO_NET_NO_TRANSFER');
    expect(closure.noTransferStatement).toBe(ZERO_NET_NO_TRANSFER_TEXT);
    expect(String(closure.noTransferStatement)).toContain(
      'No bank transfer occurred',
    );
    const opening = closure.openingPosition as Row;
    expect(opening.merchantGross).toBe(4600);
    expect(opening.receivableRecovery).toBe(4600);
    expect(opening.net).toBe(0);
    expect(
      (payload.coveredOccurrences as Array<Row>)[0].references,
    ).toEqual({ merchantInvoiceNumber: 'DAT-2026-0042' });
    expect(hashCanonical(stmt.canonicalJson as string)).toBe(
      stmt.statementHash,
    );
    expect(canonicalJson(payload)).toBe(stmt.canonicalJson);

    // Credit-note statement attachment happened (recovered note).
    expect(w.creditNotes[0].statementSettlementId).toBe('stl-1');
    expect(w.noteVersions).toHaveLength(1);

    // Audit: the evidence chain names proposer, approver, closer.
    const closeAudit = w.auditRows.find(
      (a) => a.action === 'settlement.batch.closed_zero_net_statement',
    )!;
    const meta = closeAudit.metadata as Row;
    expect(meta.proposer).toBe('proposer-1');
    expect(meta.approvedBy).toEqual(['checker-1']);
    expect(meta.closedBy).toBe('closer-1');
    expect(meta.noTransfer).toBe(true);

    // Deterministic replay: identical canonical JSON and hash.
    const replay = await w.exec.replay('auditor-1', 'stl-1');
    expect(replay.calculationReplayVerified).toBe(true);
    expect(replay.statementIntegrityVerified).toBe(true);
    expect(replay.statementIdentical).toBe(true);
    expect(replay.regeneratedStatementHash).toBe(stmt.statementHash);
  });

  it('EXACT-ZERO LAW: +0.01 refuses — one minor unit is not zero', async () => {
    const w = world({ netDeltaMinorUnits: 1 });
    expect(w.batches.get('stl-1')!.netAmount).toBe(0.01);
    const preview = await previewAndApprove(w);
    await expect(
      w.exec.closeZeroNet('closer-1', 'stl-1', {
        previewHash: preview.calculationHash,
      }),
    ).rejects.toThrow('zero_net_close_requires_exact_zero');
    expect(w.statements).toHaveLength(0);
    expect(w.batches.get('stl-1')!.status).toBe('ready');
  });

  it('EXACT-ZERO LAW: -0.01 refuses at the engine terminal act too (defense in depth)', async () => {
    const w = world();
    // Tamper the stored row to a negative minor unit — the ENGINE
    // guard (independent of the service check) still refuses.
    w.batches.get('stl-1')!.netAmount = -0.01;
    await expect(
      w.engine.markSettledZeroNet('closer-1', 'stl-1'),
    ).rejects.toThrow('zero_net_close_requires_exact_zero');
    expect(w.batches.get('stl-1')!.status).toBe('ready');
  });

  it('CURRENCY EXPONENT: AED and QAR zero-nets close; one minor unit in either refuses', async () => {
    for (const currency of ['AED', 'QAR']) {
      const ok = world({ currency });
      const preview = await previewAndApprove(ok);
      const res = await ok.exec.closeZeroNet('closer-1', 'stl-1', {
        previewHash: preview.calculationHash,
      });
      expect(res.closureType).toBe('zero_net_no_transfer');
      expect(ok.remittances).toHaveLength(0);

      const bad = world({ currency, netDeltaMinorUnits: 1 });
      const p2 = await previewAndApprove(bad);
      await expect(
        bad.exec.closeZeroNet('closer-1', 'stl-1', {
          previewHash: p2.calculationHash,
        }),
      ).rejects.toThrow('zero_net_close_requires_exact_zero');
    }
  });

  it('IDEMPOTENT + CONCURRENT: repeat and racing closes produce ONE close and ONE statement', async () => {
    const w = world();
    const preview = await previewAndApprove(w);
    const [a, b] = await Promise.all([
      w.exec.closeZeroNet('closer-1', 'stl-1', {
        previewHash: preview.calculationHash,
      }),
      w.exec.closeZeroNet('closer-1', 'stl-1', {
        previewHash: preview.calculationHash,
      }),
    ]);
    // Third call after completion: the healed idempotent lane.
    const c = await w.exec.closeZeroNet('closer-1', 'stl-1', {
      previewHash: preview.calculationHash,
    });
    expect(w.statements).toHaveLength(1);
    expect(w.remittances).toHaveLength(0);
    for (const r of [a, b, c]) {
      expect(r.statement!.statementHash).toBe(
        w.statements[0].statementHash,
      );
    }
    // The recovery posting exists exactly once (deterministic key).
    expect(
      w.ledgerRows.filter(
        (r) => r.eventType === 'merchant.receivable.recovered',
      ),
    ).toHaveLength(1);
  });

  it('FINDING 1 PIN: the in-transaction contended lane — a racer settling between loadBatch and the guarded transition loses cleanly', async () => {
    const w = world();
    const preview = await previewAndApprove(w);
    // Flip the batch to settled AFTER the service's frozenRecord read
    // but BEFORE the engine's guarded ready→settled update: the
    // guarded updateMany (status:'ready') finds nothing and the whole
    // transaction refuses — no partial close, no statement.
    const um = w.prisma.settlementBatch.updateMany as jest.Mock;
    const real = um.getMockImplementation()!;
    um.mockImplementationOnce((args: never) => {
      const row = w.batches.get('stl-1')!;
      row.status = 'settled';
      row.closureType = 'remitted'; // the racer was a bank execution
      return real(args);
    });
    await expect(
      w.exec.closeZeroNet('closer-1', 'stl-1', {
        previewHash: preview.calculationHash,
      }),
    ).rejects.toThrow('settlement_batch_contended');
    expect(w.statements).toHaveLength(0);
    expect(w.items[0].state).toBe('ready'); // nothing settled
    expect(w.receivables[0].state).toBe('open'); // nothing consumed
  });

  it('SUPERSEDED batch refuses; REMITTED-settled batch refuses the zero-net lane', async () => {
    const w = world();
    w.batches.get('stl-1')!.status = 'superseded';
    await expect(
      w.exec.closeZeroNet('closer-1', 'stl-1', { previewHash: 'x' }),
    ).rejects.toThrow('execution_requires_ready:superseded');

    const w2 = world();
    w2.batches.get('stl-1')!.status = 'settled';
    w2.batches.get('stl-1')!.closureType = 'remitted';
    await expect(
      w2.exec.closeZeroNet('closer-1', 'stl-1', { previewHash: 'x' }),
    ).rejects.toThrow('settlement_already_remitted');
    // And the engine refuses a bank-lane settle against a zero-net
    // closed batch (no fabricated movement after the fact).
    const w3 = world();
    w3.batches.get('stl-1')!.status = 'settled';
    w3.batches.get('stl-1')!.closureType = 'zero_net_no_transfer';
    await expect(
      w3.engine.markSettled('exec-1', 'stl-1', {
        bankTransferReference: 'FAKE-1',
        executedAt: new Date(T0),
        executedBy: 'exec-1',
      }),
    ).rejects.toThrow('settlement_closed_zero_net');
  });

  it('TAMPERED/CHANGED preview refuses: wrong hash, and drifted items', async () => {
    const w = world();
    await previewAndApprove(w);
    await expect(
      w.exec.closeZeroNet('closer-1', 'stl-1', {
        previewHash: 'not-the-reviewed-hash',
      }),
    ).rejects.toThrow('preview_hash_mismatch');
    // Item drift (a landed hold) refuses the close (§33.3).
    const w2 = world();
    const p2 = await previewAndApprove(w2);
    w2.items[0].state = 'held';
    await expect(
      w2.exec.closeZeroNet('closer-1', 'stl-1', {
        previewHash: p2.calculationHash,
      }),
    ).rejects.toThrow('batch_drifted');
  });

  it('SEPARATION: the final approver cannot close (§33.2)', async () => {
    const w = world();
    const preview = await previewAndApprove(w); // approved by checker-1
    await expect(
      w.exec.closeZeroNet('checker-1', 'stl-1', {
        previewHash: preview.calculationHash,
      }),
    ).rejects.toThrow();
    expect(w.batches.get('stl-1')!.status).toBe('ready');
    expect(w.statements).toHaveLength(0);
  });

  it('GATES: the close refuses when the platform gates are not attested (positions may not close either)', async () => {
    delete process.env[GATES_ENV];
    try {
      const w = world();
      await expect(
        w.exec.closeZeroNet('closer-1', 'stl-1', { previewHash: 'x' }),
      ).rejects.toThrow('financial_gates_not_attested');
    } finally {
      process.env[GATES_ENV] = 'true';
    }
  });

  it('NO PII: statement canonical bytes, ledger rows, and audit metadata carry references only', async () => {
    const w = world();
    const preview = await previewAndApprove(w);
    await w.exec.closeZeroNet('closer-1', 'stl-1', {
      previewHash: preview.calculationHash,
    });
    const surfaces = [
      w.statements[0].canonicalJson as string,
      JSON.stringify(w.ledgerRows),
      JSON.stringify(w.auditRows),
    ];
    for (const surface of surfaces) {
      const lower = surface.toLowerCase();
      for (const banned of [
        '"recipientname"', '"phone"', '"address"', '"email"',
        '"city"', '"district"', '"lat"', '"lng"',
      ]) {
        expect(lower).not.toContain(banned);
      }
    }
  });
});
