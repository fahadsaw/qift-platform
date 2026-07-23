// Three-way Treasury Reconciliation — the executable FINANCIAL
// WALKTHROUGH (Lane 2 PR 1). SC §10.3 / §13.3 / §24; FC Ch. 17.2.
//
// The narrative: a pilot day in the life of the safeguarding account
// — receipt lands, remittance leaves, refund returns, recovery draws
// — reconciled daily against attested bank evidence, with every
// difference enumerated and the mismatch lifecycle walked to
// resolution. Plus the founder's hard boundaries pinned: no invented
// balance, read-only over money, integrity before rendering.

import { readFileSync } from 'fs';
import { join } from 'path';
import { TreasuryReconciliationService } from './treasury-reconciliation.service';
import { TreasuryInternalTransferService } from './treasury-internal-transfer.service';
import { hashCanonical } from '../settlement/settlement-statement';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type Row = Record<string, unknown>;

const NOW = '2026-07-23T12:00:00.000Z';
const D = (day: string, hm = '10:00') => new Date(`2026-07-${day}T${hm}:00.000Z`);

function world() {
  let seq = 0;
  const ledgerRows: Row[] = [];
  const receipts: Row[] = [];
  const remittances: Row[] = [];
  const refunds: Row[] = [];
  const attestations: Row[] = [];
  const reconciliations: Row[] = [];
  const transfers: Row[] = [];
  const auditRows: Row[] = [];

  const prisma = {
    financialLedgerEntry: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { eventType: string | { in: string[] } };
        const wanted =
          typeof w.eventType === 'string' ? [w.eventType] : w.eventType.in;
        return Promise.resolve(
          ledgerRows
            .filter((r) => wanted.includes(r.eventType as string))
            .map((r) => ({ ...r })),
        );
      }),
    },
    paymentReceipt: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const ids = (where as { id: { in: string[] } }).id.in;
        return Promise.resolve(
          receipts.filter((r) => ids.includes(r.id as string)).map((r) => ({ ...r })),
        );
      }),
    },
    settlementRemittance: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as {
          id?: { in: string[] };
          settlementId?: { in: string[] };
        };
        return Promise.resolve(
          remittances
            .filter((r) =>
              w.id
                ? w.id.in.includes(r.id as string)
                : w.settlementId!.in.includes(r.settlementId as string),
            )
            .map((r) => ({ ...r })),
        );
      }),
    },
    settlementRefund: {
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const ids = (where as { id: { in: string[] } }).id.in;
        return Promise.resolve(
          refunds.filter((r) => ids.includes(r.id as string)).map((r) => ({ ...r })),
        );
      }),
    },
    treasuryAttestation: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row: Row = {
          id: `att-${++seq}`,
          notes: null,
          createdAt: new Date(NOW),
          ...(data as Row),
        };
        attestations.push(row);
        return Promise.resolve({ ...row });
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const found = attestations.find(
          (a) => a.id === (where as { id: string }).id,
        );
        return Promise.resolve(found ? { ...found } : null);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { accountType: string; asOfDate: Date };
        const hits = attestations.filter(
          (a) =>
            a.accountType === w.accountType &&
            (a.asOfDate as Date).getTime() === w.asOfDate.getTime(),
        );
        const last = hits[hits.length - 1];
        return Promise.resolve(last ? { ...last } : null);
      }),
      findMany: jest.fn().mockImplementation(() =>
        Promise.resolve(attestations.map((a) => ({ ...a }))),
      ),
    },
    treasuryReconciliation: {
      findFirst: jest.fn().mockImplementation(() => {
        const sorted = [...reconciliations].sort((x, y) =>
          (y.asOfDate as Date).getTime() - (x.asOfDate as Date).getTime(),
        );
        return Promise.resolve(sorted[0] ? { ...sorted[0] } : null);
      }),
      count: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where ?? {}) as { status?: string };
        return Promise.resolve(
          reconciliations.filter(
            (r) => w.status === undefined || r.status === w.status,
          ).length,
        );
      }),
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row: Row = {
          id: `rec-${++seq}`,
          attestationId: null,
          bankBalance: null,
          bankVsCashDelta: null,
          investigatedBy: null,
          investigatedAt: null,
          investigationNotes: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          resolutionEvidenceRef: null,
          createdAt: new Date(NOW),
          ...(data as Row),
        };
        reconciliations.push(row);
        return Promise.resolve({ ...row });
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const found = reconciliations.find(
          (r) => r.id === (where as { id: string }).id,
        );
        return Promise.resolve(found ? { ...found } : null);
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where ?? {}) as { status?: string };
        return Promise.resolve(
          reconciliations
            .filter((r) => !w.status || r.status === w.status)
            .map((r) => ({ ...r })),
        );
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as { id: string; status: string };
        const hits = reconciliations.filter(
          (r) => r.id === w.id && r.status === w.status,
        );
        for (const r of hits) Object.assign(r, data as Row);
        return Promise.resolve({ count: hits.length });
      }),
    },
    treasuryInternalTransfer: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const d = data as Row;
        if (
          transfers.some((t) => t.bankReference === d.bankReference)
        ) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row: Row = {
          id: `itx-${transfers.length + 1}`,
          notes: null,
          createdAt: new Date(NOW),
          ...d,
        };
        transfers.push(row);
        return Promise.resolve({ ...row });
      }),
      findFirst: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { settlementId: string; status: string };
        const found = transfers.find(
          (t) => t.settlementId === w.settlementId && t.status === w.status,
        );
        return Promise.resolve(found ? { ...found } : null);
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where ?? {}) as { status?: string };
        return Promise.resolve(
          transfers
            .filter((t) => w.status === undefined || t.status === w.status)
            .map((t) => ({ ...t })),
        );
      }),
    },
    $transaction: jest.fn(),
  };
  (prisma as { $transaction: jest.Mock }).$transaction.mockImplementation(
    (fn: (tx: unknown) => unknown) => fn(prisma),
  );
  const audit = {
    record: jest.fn().mockImplementation((row: Row) => {
      auditRows.push(row);
      return Promise.resolve(undefined);
    }),
    recordGuaranteed: jest.fn().mockImplementation((row: Row) => {
      auditRows.push(row);
      return Promise.resolve(undefined);
    }),
  };
  const ledgerService = {
    record: jest.fn().mockImplementation((row: Row) => {
      const existing = ledgerRows.find(
        (r) => r.idempotencyKey === row.idempotencyKey,
      );
      if (existing) return Promise.resolve(existing);
      ledgerRows.push({ ...row, createdAt: new Date(NOW) });
      return Promise.resolve(row);
    }),
  };
  const internalTransfers = new TreasuryInternalTransferService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledgerService as never,
    { now: () => new Date(NOW) },
  );
  const service = new TreasuryReconciliationService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    { now: () => new Date(NOW) },
    internalTransfers,
  );

  // Ledger scenario helpers — rows shaped EXACTLY like the real
  // producers write them (event, key anchor, metadata.account).
  const addReceipt = (opts: {
    receiptId: string;
    amount: number;
    receivedAt: Date;
    invoiceType: 'merchant_invoice' | 'corporate_invoice';
    bankReference: string;
  }) => {
    receipts.push({
      id: opts.receiptId,
      receivedAt: opts.receivedAt,
      bankReference: opts.bankReference,
    });
    ledgerRows.push({
      id: `led-${++seq}`,
      eventType: 'invoice.payment.received',
      amount: opts.amount,
      currency: 'SAR',
      direction: 'credit',
      orderId: null,
      storeId: 's-1',
      createdAt: opts.receivedAt,
      idempotencyKey: `invoice.payment.received:${opts.receiptId}`,
      metadata: {
        account:
          opts.invoiceType === 'merchant_invoice' ? 'safeguarding' : 'operating',
        invoiceNumber:
          opts.invoiceType === 'merchant_invoice' ? 'DAT-2026-0042' : 'QC-2026-00001',
        bankReference: opts.bankReference,
      },
    });
    if (opts.invoiceType === 'merchant_invoice') {
      ledgerRows.push({
        id: `led-${++seq}`,
        eventType: 'merchant.payable.accrued',
        amount: opts.amount,
        currency: 'SAR',
        direction: 'debit',
        orderId: null,
        storeId: 's-1',
        createdAt: opts.receivedAt,
        idempotencyKey: `merchant.payable.accrued:${opts.receiptId}`,
        metadata: { invoiceNumber: 'DAT-2026-0042', passThrough: true },
      });
    }
  };
  const addRemittance = (opts: {
    remittanceId: string;
    settlementId: string;
    amount: number;
    executedAt: Date;
  }) => {
    remittances.push({
      id: opts.remittanceId,
      settlementId: opts.settlementId,
      executedAt: opts.executedAt,
      bankTransferReference: `TT-OUT-${opts.remittanceId}`,
      settlementReference: 'QS-AAAA-BBBB',
    });
    ledgerRows.push({
      id: `led-${++seq}`,
      eventType: 'merchant.remittance.paid',
      amount: opts.amount,
      currency: 'SAR',
      direction: 'credit',
      orderId: null,
      storeId: 's-1',
      createdAt: opts.executedAt,
      idempotencyKey: `merchant.remittance.paid:${opts.remittanceId}`,
      metadata: { settlementReference: 'QS-AAAA-BBBB', account: 'safeguarding' },
    });
  };
  const addGoodsRefund = (opts: {
    refundId: string;
    amount: number;
    refundedAt: Date;
    account: 'safeguarding' | 'operating';
  }) => {
    refunds.push({
      id: opts.refundId,
      refundedAt: opts.refundedAt,
      evidenceRef: `BANK-REF-${opts.refundId}`,
    });
    ledgerRows.push({
      id: `led-${++seq}`,
      eventType: 'refund.paid',
      amount: opts.amount,
      currency: 'SAR',
      direction: 'debit',
      orderId: null,
      storeId: 's-1',
      createdAt: opts.refundedAt,
      idempotencyKey: `refund.paid:${opts.refundId}`,
      metadata: {
        account: opts.account,
        invoiceNumber: 'DAT-2026-0042',
        passThrough: true,
      },
    });
  };
  const addRecovery = (opts: {
    receivableId: string;
    settlementId: string;
    amount: number;
  }) => {
    ledgerRows.push({
      id: `led-${++seq}`,
      eventType: 'merchant.receivable.recovered',
      amount: opts.amount,
      currency: 'SAR',
      direction: 'debit',
      orderId: null,
      storeId: 's-1',
      createdAt: new Date(NOW),
      idempotencyKey: `merchant.receivable.recovered:${opts.receivableId}:${opts.settlementId}`,
      metadata: {
        settlementReference: 'QS-AAAA-BBBB',
        accountFrom: 'safeguarding',
        accountTo: 'operating',
      },
    });
  };
  const addConsumerPayable = (orderId: string, amount: number) => {
    ledgerRows.push({
      id: `led-${++seq}`,
      eventType: 'merchant.payable.accrued',
      amount,
      currency: 'SAR',
      direction: 'debit',
      orderId,
      storeId: 's-1',
      createdAt: new Date(NOW),
      idempotencyKey: `merchant.payable.accrued:${orderId}`,
      metadata: {},
    });
  };

  return {
    service,
    internalTransfers,
    transfers,
    prisma,
    audit,
    auditRows,
    ledgerRows,
    reconciliations,
    addReceipt,
    addRemittance,
    addGoodsRefund,
    addRecovery,
    addConsumerPayable,
  };
}

const FIN = 'fin-1';

describe('Treasury walkthrough — a pilot day reconciled three ways', () => {
  it('WALKTHROUGH: receipt → remittance → refund → recovery, attested and MATCHED; then a bank delta walked mismatched → investigated → resolved', async () => {
    const w = world();

    // Day 20 — goods receipt 5,750.00 lands in safeguarding (fee
    // receipt 172.50 goes to operating — out of safeguarding scope).
    w.addReceipt({
      receiptId: 'rcpt-1', amount: 5750, receivedAt: D('20'),
      invoiceType: 'merchant_invoice', bankReference: 'TT-9001',
    });
    w.addReceipt({
      receiptId: 'rcpt-2', amount: 172.5, receivedAt: D('20', '11:00'),
      invoiceType: 'corporate_invoice', bankReference: 'TT-9002',
    });
    // Day 21 — settlement executes: remittance 5,000.00 out, recovery
    // draw 250.00 (safeguarding → operating), and a pre-settlement
    // goods refund 500.00 returns to the payer from safeguarding.
    w.addRemittance({
      remittanceId: 'rem-1', settlementId: 'setl-1',
      amount: 5000, executedAt: D('21'),
    });
    w.addRecovery({ receivableId: 'rcv-1', settlementId: 'setl-1', amount: 250 });
    w.addGoodsRefund({
      refundId: 'ref-1', amount: 500, refundedAt: D('21', '14:00'),
      account: 'safeguarding',
    });
    // A consumer-lane payable (MockGateway — no real cash) exists and
    // must be EXCLUDED with a count, never silently dropped.
    w.addConsumerPayable('order-77', 90);

    // Day 21 close — the bank says exactly what the books derive:
    // 5750 − 5000 − 250 − 500 = 0.00? No: 5750 − 5000 − 250 − 500 = 0.
    // The safeguarding account is fully swept — attest 0.00.
    await w.service.recordAttestation(FIN, {
      balance: 0,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-2026-07-21',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    expect(rec.status).toBe('matched');
    expect(Number(rec.ledgerCashBalance)).toBe(0);
    expect(Number(rec.obligationsBalance)).toBe(0);
    expect(rec.differenceCount).toBe(0);
    expect(rec.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    // The full snapshot enumerates every movement with references and
    // the excluded consumer row.
    const full = await w.service.getReconciliation(rec.id as string);
    const snap = full.snapshot as {
      cash: { included: Array<{ reference: string }> };
      excluded: Array<{ class: string; count: number }>;
    };
    expect(snap.cash.included.length).toBe(4); // receipt, remit, refund, recovery
    expect(
      snap.excluded.find((e) => e.class === 'consumer_lane_payable')?.count,
    ).toBe(1);
    expect(
      snap.excluded.find((e) => e.class === 'operating_account_cash')?.count,
    ).toBe(1); // the fee receipt

    // DETERMINISM: re-running the same day reproduces the identical
    // canonical bytes and hash (append-only — a NEW record).
    const rec2 = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    expect(rec2.snapshotHash).toBe(rec.snapshotHash);
    expect(rec2.id).not.toBe(rec.id);

    // Day 22 — the bank statement shows 300.00 the books cannot see
    // (an off-book wire — SC §27's forbidden event, DETECTED).
    await w.service.recordAttestation(FIN, {
      balance: 300,
      asOfDate: '2026-07-22T23:59:59.000Z',
      evidenceRef: 'STMT-2026-07-22',
    });
    const bad = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-22T23:59:59.000Z',
    });
    expect(bad.status).toBe('mismatched');
    expect(Number(bad.bankVsCashDelta)).toBe(300);
    expect(bad.differenceCount).toBe(1);

    // Lifecycle: mismatched → investigated → resolved, notes +
    // evidence required, all audited. Resolution documents; it never
    // moves money.
    await expect(
      w.service.resolve(FIN, bad.id as string, {
        notes: 'skip investigation',
        resolutionKind: 'new_evidence',
        evidenceRef: 'X',
      }),
    ).rejects.toThrow('treasury_reconciliation_not_resolvable:mismatched');
    const inv = await w.service.investigate(FIN, bad.id as string, {
      notes: 'Bank shows unidentified 300.00 credit — querying bank.',
    });
    expect(inv.status).toBe('investigated');
    // Scope D separation: FIN attested the bank leg — FIN cannot also
    // resolve; a free-text-only resolution refuses; a second finance
    // identity resolves with STRUCTURED new evidence.
    await expect(
      w.service.resolve(FIN, bad.id as string, {
        notes: 'closing',
        resolutionKind: 'new_evidence',
        evidenceRef: 'BANK-ADVICE-4471',
      }),
    ).rejects.toThrow('treasury_attester_cannot_resolve');
    await expect(
      w.service.resolve('fin-2', bad.id as string, {
        notes: 'just trust me',
        resolutionKind: '',
      } as never),
    ).rejects.toThrow('treasury_resolution_kind_required');
    const res = await w.service.resolve('fin-2', bad.id as string, {
      notes:
        'Bank confirmed misrouted deposit; returned by bank same day — see advice note.',
      resolutionKind: 'new_evidence',
      evidenceRef: 'BANK-ADVICE-4471',
    });
    expect(res.status).toBe('resolved');
    expect(
      w.auditRows.map((a) => a.action),
    ).toEqual([
      'finance.treasury.attested',
      'finance.treasury.reconciled',
      'finance.treasury.reconciled',
      'finance.treasury.attested',
      'finance.treasury.reconciled',
      'finance.treasury.investigated',
      'finance.treasury.resolved',
    ]);
  });

  it('NO INVENTED BALANCE: no attestation for the day → PENDING with null bank leg; attestation without evidence refuses', async () => {
    const w = world();
    w.addReceipt({
      receiptId: 'rcpt-1', amount: 1000, receivedAt: D('20'),
      invoiceType: 'merchant_invoice', bankReference: 'TT-1',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T00:00:00.000Z',
    });
    expect(rec.status).toBe('pending');
    expect(rec.bankBalance).toBeNull();
    expect(rec.bankVsCashDelta).toBeNull();
    await expect(
      w.service.recordAttestation(FIN, {
        balance: 1000,
        asOfDate: '2026-07-21T00:00:00.000Z',
        evidenceRef: '   ',
      }),
    ).rejects.toThrow('treasury_evidence_required');
  });

  it('DATE LAW: an explicit attestation for a DIFFERENT date refuses — a balance is a fact AT a date', async () => {
    const w = world();
    const att = await w.service.recordAttestation(FIN, {
      balance: 0,
      asOfDate: '2026-07-20T23:59:59.000Z',
      evidenceRef: 'STMT-20',
    });
    await expect(
      w.service.runReconciliation(FIN, {
        asOfDate: '2026-07-21T23:59:59.000Z',
        attestationId: att.id as string,
      }),
    ).rejects.toThrow('treasury_attestation_date_mismatch');
  });

  it('TIMING: a remittance value-dated after asOf is enumerated as timing, and the pre-remittance balance still MATCHES', async () => {
    const w = world();
    w.addReceipt({
      receiptId: 'rcpt-1', amount: 5750, receivedAt: D('20'),
      invoiceType: 'merchant_invoice', bankReference: 'TT-1',
    });
    w.addRemittance({
      remittanceId: 'rem-1', settlementId: 'setl-1',
      amount: 5750, executedAt: D('25'), // executes AFTER the close
    });
    await w.service.recordAttestation(FIN, {
      balance: 5750,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-21',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    expect(rec.status).toBe('matched');
    const full = await w.service.getReconciliation(rec.id as string);
    const snap = full.snapshot as { cash: { timing: unknown[] } };
    expect(snap.cash.timing).toHaveLength(1);
  });

  it('EXCEPTION: a ledger movement whose evidence row is missing is enumerated and the day is MISMATCHED', async () => {
    const w = world();
    // Remittance posting with NO SettlementRemittance row (crashed
    // half-write or tampered history).
    w.ledgerRows.push({
      id: 'led-orphan',
      eventType: 'merchant.remittance.paid',
      amount: 100,
      currency: 'SAR',
      direction: 'credit',
      orderId: null,
      storeId: 's-1',
      createdAt: D('20'),
      idempotencyKey: 'merchant.remittance.paid:rem-ghost',
      metadata: { account: 'safeguarding' },
    });
    await w.service.recordAttestation(FIN, {
      balance: 0,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-21',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    expect(rec.status).toBe('mismatched');
    const full = await w.service.getReconciliation(rec.id as string);
    const snap = full.snapshot as {
      differences: Array<{ kind: string; ledgerId?: string }>;
    };
    expect(
      snap.differences.find((d) => d.kind === 'unresolved_evidence')?.ledgerId,
    ).toBe('led-orphan');
  });

  it('§26 ZERO-NET CLOSE (Lane 2 PR 2): classified NON-CASH — matched with the internal-transfer-due enumerated, never a mismatch', async () => {
    const w = world();
    // Goods receipt 4,600 lands in safeguarding (payable accrues)...
    w.addReceipt({
      receiptId: 'rcpt-1', amount: 4600, receivedAt: D('20'),
      invoiceType: 'merchant_invoice', bankReference: 'TT-9001',
    });
    // ...then a §26 statement-only close extinguishes the payable via
    // receivable recovery — the posting carries closureType +
    // closedAt and NO cash-account claim, exactly as the engine
    // writes it. No remittance row exists anywhere.
    w.ledgerRows.push({
      id: 'led-zn-1',
      eventType: 'merchant.receivable.recovered',
      amount: 4600,
      currency: 'SAR',
      direction: 'debit',
      orderId: null,
      storeId: 's-1',
      createdAt: D('21'),
      idempotencyKey: 'merchant.receivable.recovered:rcv-1:stl-zn',
      metadata: {
        settlementReference: 'QS-ZERO-0001',
        receivableId: 'rcv-1',
        refundId: 'ref-1',
        closureType: 'zero_net_no_transfer',
        closedAt: D('21').toISOString(),
        internalTransferDue: true,
      },
    });
    // The bank still holds the 4,600 — nothing moved at close.
    await w.service.recordAttestation(FIN, {
      balance: 4600,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-2026-07-21',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    // MATCHED: cash 4,600 = bank 4,600; obligations 0 (payable
    // extinguished); the 4,600 gap between the legs is EXPLAINED by
    // the enumerated internal-transfer-due classification.
    expect(rec.status).toBe('matched');
    expect(rec.differenceCount).toBe(0);
    const full = await w.service.getReconciliation(rec.id as string);
    const snap = full.snapshot as {
      legs: { internalTransferDueMinor: number };
      nonCashClosures: Array<{ ledgerId: string; nonCash?: boolean }>;
      deltas: { rawCashVsObligationsMinor: number; cashVsObligationsMinor: number };
    };
    expect(snap.legs.internalTransferDueMinor).toBe(460000);
    expect(snap.nonCashClosures).toHaveLength(1);
    expect(snap.nonCashClosures[0].ledgerId).toBe('led-zn-1');
    expect(snap.deltas.rawCashVsObligationsMinor).toBe(460000);
    expect(snap.deltas.cashVsObligationsMinor).toBe(0); // adjusted
  });

  it('INTEGRITY GATE: a tampered stored snapshot refuses to render', async () => {
    const w = world();
    await w.service.recordAttestation(FIN, {
      balance: 0,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-21',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    const stored = w.reconciliations.find((r) => r.id === rec.id)!;
    stored.canonicalJson = (stored.canonicalJson as string).replace(
      '"matched"',
      '"resolved"',
    );
    await expect(
      w.service.getReconciliation(rec.id as string),
    ).rejects.toThrow('treasury_reconciliation_integrity_violation');
    expect(hashCanonical(stored.canonicalJson as string)).not.toBe(
      stored.snapshotHash,
    );
  });

  it('GRAND WALKTHROUGH (PR 3): receipt → payable → receivable → zero-net close → statement due → explained recon → evidence → completed → matched with NO outstanding — audited end to end', async () => {
    const w = world();
    // Business event: goods receipt 4,600 lands (payable accrues)...
    w.addReceipt({
      receiptId: 'rcpt-1', amount: 4600, receivedAt: D('20'),
      invoiceType: 'merchant_invoice', bankReference: 'TT-9001',
    });
    // ...a post-settlement refund fronted by Qift became a receivable,
    // and the next batch closed ZERO-NET (§26): the engine posted the
    // position extinguishment with closureType + closedAt and NO cash
    // claim, exactly as markSettledZeroNet writes it.
    w.ledgerRows.push({
      id: 'led-zn-1',
      eventType: 'merchant.receivable.recovered',
      amount: 4600,
      currency: 'SAR',
      direction: 'debit',
      orderId: null,
      storeId: 's-1',
      createdAt: D('21'),
      idempotencyKey: 'merchant.receivable.recovered:rcv-1:stl-zn',
      metadata: {
        settlementReference: 'QS-ZERO-0001',
        receivableId: 'rcv-1',
        refundId: 'ref-1',
        closureType: 'zero_net_no_transfer',
        closedAt: D('21').toISOString(),
        internalTransferDue: true,
      },
    });

    // Day 21: bank still holds 4,600 — the reconciliation MATCHES
    // with the outstanding internal transfer EXPLAINED and VISIBLE.
    await w.service.recordAttestation(FIN, {
      balance: 4600,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-21',
    });
    const rec1 = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    expect(rec1.status).toBe('matched');
    const full1 = await w.service.getReconciliation(rec1.id as string);
    const snap1 = full1.snapshot as {
      identity: { timezone: string; cutoffAt: string };
      attestationEvidenceHash: string;
      legs: { internalTransferOutstandingMinor: number };
      pendingInternalTransfers: Array<{ settlementReference: string }>;
    };
    // Scope D run identity + evidence hash on every run.
    expect(snap1.identity.timezone).toBe('UTC');
    expect(snap1.attestationEvidenceHash).toMatch(/^[0-9a-f]{64}$/);
    // The outstanding transfer is NEVER hidden by the explanation.
    expect(snap1.legs.internalTransferOutstandingMinor).toBe(460000);
    expect(snap1.pendingInternalTransfers).toHaveLength(1);
    expect(snap1.pendingInternalTransfers[0].settlementReference).toBe(
      'QS-ZERO-0001',
    );
    // Pending view with aging (Scope C).
    const pending = await w.internalTransfers.pendingInternalTransfers();
    expect(pending).toHaveLength(1);
    expect(pending[0].outstandingMinor).toBe(460000);

    // Evidence law: completion REQUIRES full evidence — masked
    // accounts only, exact confirmed amount, unique bank reference.
    await expect(
      w.internalTransfers.recordInternalTransfer(FIN, {
        settlementId: 'stl-zn',
        bankReference: 'ITX-100',
        valueDate: '2026-07-22T09:00:00.000Z',
        confirmedAmount: 4600,
        accountFromMasked: 'SA4412345678901234567890', // RAW — refuse
        accountToMasked: '****9012',
      }),
    ).rejects.toThrow('internal_transfer_account_not_masked');
    await expect(
      w.internalTransfers.recordInternalTransfer(FIN, {
        settlementId: 'stl-zn',
        bankReference: 'ITX-100',
        valueDate: '2026-07-22T09:00:00.000Z',
        confirmedAmount: 4599.99, // one minor short — refuse
        accountFromMasked: '****5678',
        accountToMasked: '****9012',
      }),
    ).rejects.toThrow('internal_transfer_amount_mismatch');

    // The evidenced completion: bank ref, value date, confirmed
    // amount, executor, masked accounts — posts the REAL cash event.
    const done = await w.internalTransfers.recordInternalTransfer(FIN, {
      settlementId: 'stl-zn',
      bankReference: 'ITX-100',
      valueDate: '2026-07-22T09:00:00.000Z',
      confirmedAmount: 4600,
      accountFromMasked: '****5678',
      accountToMasked: '****9012',
    });
    expect(done.status).toBe('completed');
    const cashEvent = w.ledgerRows.find(
      (r) => r.eventType === 'treasury.internal_transfer.completed',
    )!;
    expect(cashEvent.amount).toBe(4600);
    expect((cashEvent.metadata as Row).accountFromMasked).toBe('****5678');

    // Duplicate evidence rejected; double completion rejected.
    await expect(
      w.internalTransfers.recordInternalTransfer(FIN, {
        settlementId: 'stl-zn',
        bankReference: 'ITX-100',
        valueDate: '2026-07-22T09:00:00.000Z',
        confirmedAmount: 4600,
        accountFromMasked: '****5678',
        accountToMasked: '****9012',
      }),
    ).rejects.toThrow('internal_transfer_already_completed');

    // Day 22: bank swept to 0 — the next reconciliation MATCHES with
    // NO outstanding transfer.
    await w.service.recordAttestation(FIN, {
      balance: 0,
      asOfDate: '2026-07-22T23:59:59.000Z',
      evidenceRef: 'STMT-22',
    });
    const rec2 = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-22T23:59:59.000Z',
    });
    expect(rec2.status).toBe('matched');
    const full2 = await w.service.getReconciliation(rec2.id as string);
    const snap2 = full2.snapshot as {
      legs: {
        internalTransferOutstandingMinor: number;
        internalTransferCompletedMinor: number;
      };
      pendingInternalTransfers: unknown[];
      alerts: unknown[];
    };
    expect(snap2.legs.internalTransferCompletedMinor).toBe(460000);
    expect(snap2.legs.internalTransferOutstandingMinor).toBe(0);
    expect(snap2.pendingInternalTransfers).toHaveLength(0);
    expect(snap2.alerts).toHaveLength(0);

    // Guaranteed audit trail names every act.
    const actions = w.auditRows.map((a) => a.action);
    expect(actions).toContain('finance.treasury.internal_transfer.completed');
    expect(actions.filter((x) => x === 'finance.treasury.attested')).toHaveLength(2);
    expect(actions.filter((x) => x === 'finance.treasury.reconciled')).toHaveLength(2);

    // Health endpoint: reconciliation-zero holds, nothing pending.
    const health = await w.service.health();
    expect(health.reconciliationZero).toBe(true);
    expect(health.pendingInternalTransfers).toHaveLength(0);
  });

  it('SCOPE C: an outstanding transfer stays VISIBLY pending, ages, and alerts past the threshold', async () => {
    const w = world();
    w.addReceipt({
      receiptId: 'rcpt-old', amount: 1000, receivedAt: D('14'),
      invoiceType: 'merchant_invoice', bankReference: 'TT-OLD-1',
    });
    w.ledgerRows.push({
      id: 'led-zn-old',
      eventType: 'merchant.receivable.recovered',
      amount: 1000,
      currency: 'SAR',
      direction: 'debit',
      orderId: null,
      storeId: 's-1',
      createdAt: D('15'),
      idempotencyKey: 'merchant.receivable.recovered:rcv-9:stl-old',
      metadata: {
        settlementReference: 'QS-OLD-0001',
        receivableId: 'rcv-9',
        refundId: 'ref-9',
        closureType: 'zero_net_no_transfer',
        closedAt: '2026-07-15T10:00:00.000Z', // 8 days before NOW
        internalTransferDue: true,
      },
    });
    const pending = await w.internalTransfers.pendingInternalTransfers();
    expect(pending[0].ageDays).toBeGreaterThanOrEqual(3);
    await w.service.recordAttestation(FIN, {
      balance: 1000,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-21',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    const full = await w.service.getReconciliation(rec.id as string);
    const snap = full.snapshot as { alerts: Array<{ kind: string }> };
    expect(
      snap.alerts.some((x) => x.kind === 'internal_transfer_pending_aging'),
    ).toBe(true);
    // Matched (explained) — but the alert still fires: explained
    // NEVER means hidden.
    expect(rec.status).toBe('matched');
  });

  it('SCOPE C: evidence is mandatory — completion without outstanding due, or with a reused bank reference, refuses', async () => {
    const w = world();
    await expect(
      w.internalTransfers.recordInternalTransfer(FIN, {
        settlementId: 'stl-none',
        bankReference: 'ITX-1',
        valueDate: '2026-07-22T09:00:00.000Z',
        confirmedAmount: 100,
        accountFromMasked: '****1111',
        accountToMasked: '****2222',
      }),
    ).rejects.toThrow('internal_transfer_nothing_outstanding');
    // Two dues, one bank reference: the second refuses (unique).
    for (const [sid, ref] of [['stl-a', 'rcv-a'], ['stl-b', 'rcv-b']] as const) {
      w.ledgerRows.push({
        id: `led-${sid}`,
        eventType: 'merchant.receivable.recovered',
        amount: 500,
        currency: 'SAR',
        direction: 'debit',
        orderId: null,
        storeId: 's-1',
        createdAt: D('21'),
        idempotencyKey: `merchant.receivable.recovered:${ref}:${sid}`,
        metadata: {
          settlementReference: `QS-${sid}`,
          receivableId: ref,
          refundId: 'ref-x',
          closureType: 'zero_net_no_transfer',
          closedAt: D('21').toISOString(),
          internalTransferDue: true,
        },
      });
    }
    await w.internalTransfers.recordInternalTransfer(FIN, {
      settlementId: 'stl-a',
      bankReference: 'ITX-SAME',
      valueDate: '2026-07-22T09:00:00.000Z',
      confirmedAmount: 500,
      accountFromMasked: '****1111',
      accountToMasked: '****2222',
    });
    await expect(
      w.internalTransfers.recordInternalTransfer(FIN, {
        settlementId: 'stl-b',
        bankReference: 'ITX-SAME', // duplicate evidence
        valueDate: '2026-07-22T09:00:00.000Z',
        confirmedAmount: 500,
        accountFromMasked: '****1111',
        accountToMasked: '****2222',
      }),
    ).rejects.toThrow('internal_transfer_evidence_reused');
  });

  it('READ-ONLY LAW (census pin): the treasury service contains no ledger writes and touches no money table', () => {
    const src = readFileSync(
      join(__dirname, 'treasury-reconciliation.service.ts'),
      'utf8',
    );
    // No ledger producer, no money-table mutation — reads only.
    expect(src).not.toContain('ledger.record');
    expect(src).not.toContain('FinancialLedgerService');
    for (const banned of [
      'financialLedgerEntry.create',
      'financialLedgerEntry.update',
      'financialLedgerEntry.delete',
      'paymentReceipt.create',
      'paymentReceipt.update',
      'settlementRemittance.create',
      'settlementRemittance.update',
      'settlementRefund.create',
      'settlementRefund.update',
      'settlementBatch',
      'settlementItem',
      'corporateInvoice.update',
      'merchantInvoice.update',
    ]) {
      expect(src).not.toContain(banned);
    }
    // Its ONLY writes are its own two treasury tables (+ audit).
    expect(src).toContain('treasuryAttestation.create');
    expect(src).toContain('treasuryReconciliation.create');
    expect(src).toContain('treasuryReconciliation.updateMany');
  });

  it('FINDING 1 PIN: a bank-independent defect on an UNATTESTED day is MISMATCHED (never pending) and fully investigable', async () => {
    const w = world();
    // One-sided posting: cash-in with NO payable conversion, no
    // attestation recorded for the day.
    w.ledgerRows.push({
      id: 'led-oneside',
      eventType: 'invoice.payment.received',
      amount: 1000,
      currency: 'SAR',
      direction: 'credit',
      orderId: null,
      storeId: 's-1',
      createdAt: D('20'),
      idempotencyKey: 'invoice.payment.received:rcpt-x',
      metadata: { account: 'safeguarding', bankReference: 'TT-X' },
    });
    (w as unknown as { prisma: { paymentReceipt: { findMany: jest.Mock } } });
    // give the receipt evidence so the defect is PURELY the asymmetry
    (w.prisma.paymentReceipt.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'rcpt-x', receivedAt: D('20'), bankReference: 'TT-X' },
    ]);
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    expect(rec.status).toBe('mismatched'); // NOT pending
    expect(rec.bankBalance).toBeNull(); // bank leg honestly absent
    const inv = await w.service.investigate(FIN, rec.id as string, {
      notes: 'one-sided posting found before attestation',
    });
    expect(inv.status).toBe('investigated');
  });

  it('FINDING 2 PIN: a tampered row does not brick the list — it carries integrityOk:false while others render', async () => {
    const w = world();
    await w.service.recordAttestation(FIN, {
      balance: 0,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-21',
    });
    const a1 = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    const a2 = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    const stored = w.reconciliations.find((r) => r.id === a1.id)!;
    stored.canonicalJson = (stored.canonicalJson as string) + ' ';
    const list = (await w.service.listReconciliations()) as Array<{
      id: string;
      integrityOk: boolean;
    }>;
    expect(list.find((r) => r.id === a1.id)!.integrityOk).toBe(false);
    expect(list.find((r) => r.id === a2.id)!.integrityOk).toBe(true);
  });

  it('STATE LAW: matched records cannot be investigated; notes are mandatory', async () => {
    const w = world();
    await w.service.recordAttestation(FIN, {
      balance: 0,
      asOfDate: '2026-07-21T23:59:59.000Z',
      evidenceRef: 'STMT-21',
    });
    const rec = await w.service.runReconciliation(FIN, {
      asOfDate: '2026-07-21T23:59:59.000Z',
    });
    expect(rec.status).toBe('matched');
    await expect(
      w.service.investigate(FIN, rec.id as string, { notes: 'why?' }),
    ).rejects.toThrow('treasury_reconciliation_not_investigable:matched');
    await expect(
      w.service.investigate(FIN, rec.id as string, { notes: '  ' }),
    ).rejects.toThrow('treasury_notes_required');
  });
});
