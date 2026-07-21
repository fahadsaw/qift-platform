// SETTLE-1 receipts — unit pins (Track C PR 2).
//
// Pins the constitutional receipt laws: occurrence-anchored postings
// (SC §11.2/§18.1), partial payments with DERIVED paid status
// (FC 6.2/roadmap 308), per-receipt payable conversion (goods),
// recognition-policy-versioned revenue (fee, FC 7.6), idempotent
// replay, the balance guard, and the Ch. 17.4 collection gate.

import {
  SettlementReceiptsService,
  REVENUE_RECOGNITION_POLICY,
} from './settlement-receipts.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';

function harness(opts?: {
  corporate?: Row[];
  merchant?: Row[];
}) {
  let seq = 0;
  const receipts: Row[] = [];
  const items: Row[] = [];
  const ledgerRows: Row[] = [];
  const auditRows: Row[] = [];
  const corp = new Map((opts?.corporate ?? []).map((r) => [r.id as string, r]));
  const merch = new Map((opts?.merchant ?? []).map((r) => [r.id as string, r]));

  const prisma = {
    paymentReceipt: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const d = data as Row;
        if (
          receipts.some(
            (r) =>
              r.invoiceType === d.invoiceType &&
              r.invoiceId === d.invoiceId &&
              r.bankReference === d.bankReference,
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row = { id: `rcpt-${++seq}`, ...d };
        receipts.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where as Row).invoiceType_invoiceId_bankReference as Row;
        return Promise.resolve(
          receipts.find(
            (r) =>
              r.invoiceType === w.invoiceType &&
              r.invoiceId === w.invoiceId &&
              r.bankReference === w.bankReference,
          ) ?? null,
        );
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as Row;
        return Promise.resolve(
          receipts
            .filter(
              (r) =>
                r.invoiceType === w.invoiceType && r.invoiceId === w.invoiceId,
            )
            .sort((a, b) =>
              ((a.receivedAt as Date).getTime() -
                (b.receivedAt as Date).getTime()) ||
              String(a.id).localeCompare(String(b.id)),
            ),
        );
      }),
    },
    corporateInvoice: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: never) =>
          Promise.resolve(corp.get((where as Row).id as string) ?? null),
        ),
      findMany: jest
        .fn()
        .mockImplementation(({ where }: never) =>
          Promise.resolve(
            [...corp.values()].filter((r) => r.status === (where as Row).status),
          ),
        ),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        const row = corp.get(w.id as string);
        if (!row || row.status !== w.status)
          return Promise.resolve({ count: 0 });
        Object.assign(row, data as Row);
        return Promise.resolve({ count: 1 });
      }),
    },
    merchantInvoice: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: never) =>
          Promise.resolve(merch.get((where as Row).id as string) ?? null),
        ),
      findMany: jest
        .fn()
        .mockImplementation(({ where }: never) =>
          Promise.resolve(
            [...merch.values()].filter(
              (r) => r.status === (where as Row).status,
            ),
          ),
        ),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        const row = merch.get(w.id as string);
        if (!row || row.status !== w.status)
          return Promise.resolve({ count: 0 });
        Object.assign(row, data as Row);
        return Promise.resolve({ count: 1 });
      }),
    },
    settlementItem: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const d = data as Row;
        if (
          items.some(
            (i) =>
              i.occurrenceType === d.occurrenceType &&
              i.occurrenceId === d.occurrenceId,
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row = { id: `sitem-${++seq}`, ...d };
        items.push(row);
        return Promise.resolve(row);
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
  const ledger = {
    // Emulates the real single write path: deterministic-key replays
    // COLLIDE with the original row (P2002 → return existing).
    record: jest.fn().mockImplementation((row: Row, client?: unknown) => {
      const existing = ledgerRows.find(
        (r) => r.idempotencyKey === row.idempotencyKey,
      );
      if (existing) return Promise.resolve(existing);
      const stored = { ...row, insideTx: client !== undefined };
      ledgerRows.push(stored);
      return Promise.resolve(stored);
    }),
  };
  const clock = { now: () => new Date('2026-07-21T09:00:00.000Z') };
  const service = new SettlementReceiptsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledger as unknown as FinancialLedgerService,
    clock,
  );
  return {
    service,
    prisma,
    audit,
    ledger,
    receipts,
    items,
    ledgerRows,
    auditRows,
    corp,
    merch,
  };
}

const merchantInvoice = (over: Row = {}): Row => ({
  id: 'minv-1',
  status: 'issued',
  totalAmount: 5750,
  currency: 'SAR',
  orgId: 'org-1',
  campaignId: 'camp-1',
  storeId: 's-1',
  merchantInvoiceNumber: 'DAT-2026-0042',
  dueDate: new Date('2026-07-15T00:00:00.000Z'),
  ...over,
});

const corporateInvoice = (over: Row = {}): Row => ({
  id: 'cinv-1',
  status: 'issued',
  totalAmount: 172.5,
  platformFeeAmount: 150,
  currency: 'SAR',
  orgId: 'org-1',
  campaignId: 'camp-1',
  invoiceNumber: 'QC-2026-00001',
  dueDate: new Date('2026-07-15T00:00:00.000Z'),
  ...over,
});

describe('SettlementReceiptsService (SETTLE-1)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('§5.7/Ch. 17.4: collections REFUSE until the platform gates are attested', async () => {
    delete process.env[GATES_ENV];
    try {
      const { service } = harness({ merchant: [merchantInvoice()] });
      await expect(
        service.recordReceipt('fin-1', {
          invoiceType: 'merchant_invoice',
          invoiceId: 'minv-1',
          amount: 5750,
          bankReference: 'TT-1',
          receivedAt: '2026-07-20T10:00:00.000Z',
        }),
      ).rejects.toThrow('financial_gates_not_attested');
    } finally {
      process.env[GATES_ENV] = 'true';
    }
  });

  it('input law: bank evidence, positive SAR amount, valid value date, known type, receivable status', async () => {
    const { service } = harness({
      merchant: [merchantInvoice(), merchantInvoice({ id: 'minv-p', status: 'paid' })],
    });
    const base = {
      invoiceType: 'merchant_invoice' as const,
      invoiceId: 'minv-1',
      amount: 100,
      bankReference: 'TT-1',
      receivedAt: '2026-07-20T10:00:00.000Z',
    };
    await expect(
      service.recordReceipt('f', { ...base, bankReference: '  ' }),
    ).rejects.toThrow('receipt_bank_reference_required');
    await expect(
      service.recordReceipt('f', { ...base, amount: 0 }),
    ).rejects.toThrow('receipt_amount_must_be_positive');
    await expect(
      service.recordReceipt('f', { ...base, amount: -5 }),
    ).rejects.toThrow('receipt_amount_must_be_positive');
    await expect(
      service.recordReceipt('f', { ...base, currency: 'USD' }),
    ).rejects.toThrow('receipt_currency_unsupported');
    await expect(
      service.recordReceipt('f', { ...base, receivedAt: 'not-a-date' }),
    ).rejects.toThrow('receipt_received_at_invalid');
    await expect(
      service.recordReceipt('f', {
        ...base,
        invoiceType: 'weird' as never,
      }),
    ).rejects.toThrow('receipt_invoice_type_unknown');
    await expect(
      service.recordReceipt('f', { ...base, invoiceId: 'minv-p' }),
    ).rejects.toThrow('receipt_invoice_not_receivable:paid');
    await expect(
      service.recordReceipt('f', { ...base, invoiceId: 'missing' }),
    ).rejects.toThrow('invoice_not_found');
  });

  it('balance guard: Σ receipts may NEVER exceed the invoice total (minor units)', async () => {
    const { service } = harness({ merchant: [merchantInvoice()] });
    await service.recordReceipt('f', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 5000,
      bankReference: 'TT-1',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    await expect(
      service.recordReceipt('f', {
        invoiceType: 'merchant_invoice',
        invoiceId: 'minv-1',
        amount: 750.01,
        bankReference: 'TT-2',
        receivedAt: '2026-07-20T11:00:00.000Z',
      }),
    ).rejects.toThrow('receipt_exceeds_invoice_balance');
  });

  it('goods receipt: cash-in + payable convert PER RECEIPT, inside the tx, occurrence-anchored', async () => {
    const { service, ledgerRows } = harness({ merchant: [merchantInvoice()] });
    const res = await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 2000,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-19T10:00:00.000Z',
    });
    expect(res.replayed).toBe(false);
    expect(res.coverage!.covered).toBe(false);
    expect(res.coverage!.balance).toBe(3750);
    expect(res.coverage!.status).toBe('issued'); // partial — NOT paid
    const rid = (res.receipt as Row).id as string;
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows[0]).toMatchObject({
      eventType: 'invoice.payment.received',
      amount: 2000,
      direction: 'credit',
      idempotencyKey: `invoice.payment.received:${rid}`,
      insideTx: true,
    });
    expect((ledgerRows[0].metadata as Row).account).toBe('safeguarding');
    expect(ledgerRows[1]).toMatchObject({
      eventType: 'merchant.payable.accrued',
      amount: 2000,
      direction: 'debit',
      idempotencyKey: `merchant.payable.accrued:${rid}`,
      insideTx: true,
    });
  });

  it('paid DERIVES from coverage: completing receipt flips status, paidAt = completing value date, item born pending', async () => {
    const { service, merch, items, auditRows } = harness({
      merchant: [merchantInvoice()],
    });
    await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 2000,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-19T10:00:00.000Z',
    });
    const res = await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 3750,
      bankReference: 'TT-9002',
      receivedAt: '2026-07-20T14:30:00.000Z',
    });
    expect(res.coverage!.covered).toBe(true);
    expect(res.coverage!.status).toBe('paid');
    const inv = merch.get('minv-1')!;
    expect(inv.status).toBe('paid');
    // The completing receipt's VALUE DATE — evidence, not wall clock.
    expect((inv.paidAt as Date).toISOString()).toBe(
      '2026-07-20T14:30:00.000Z',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      occurrenceType: 'merchant_invoice',
      occurrenceId: 'minv-1',
      storeId: 's-1',
      amount: 5750,
      state: 'pending', // §5 eligibility is the EVALUATOR's decision
    });
    expect(auditRows.map((a) => a.action)).toEqual([
      'finance.receipt.recorded',
      'finance.receipt.recorded',
      'finance.invoice.paid',
      'settlement.item.created',
    ]);
  });

  it('fee receipt: revenue recognized ONCE per invoice under the RECORDED policy version (VAT stays at issuance)', async () => {
    const { service, ledgerRows, corp } = harness({
      corporate: [corporateInvoice()],
    });
    await service.recordReceipt('fin-1', {
      invoiceType: 'corporate_invoice',
      invoiceId: 'cinv-1',
      amount: 172.5,
      bankReference: 'TT-9003',
      receivedAt: '2026-07-20T15:00:00.000Z',
    });
    expect(corp.get('cinv-1')!.status).toBe('paid');
    const cash = ledgerRows.filter(
      (r) => r.eventType === 'invoice.payment.received',
    );
    expect(cash).toHaveLength(1);
    expect((cash[0].metadata as Row).account).toBe('operating');
    const rev = ledgerRows.filter(
      (r) => r.eventType === 'qift.revenue.recognized',
    );
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({
      amount: 150, // fee NET of VAT — the 22.50 VAT posted at issuance
      direction: 'credit',
      idempotencyKey: 'qift.revenue.recognized:cinv-1',
    });
    expect((rev[0].metadata as Row).recognitionPolicy).toBe(
      REVENUE_RECOGNITION_POLICY,
    );
    // No payable and no settlement item for the fee leg — Qift's own
    // money is never merchant money.
    expect(
      ledgerRows.filter((r) => r.eventType === 'merchant.payable.accrued'),
    ).toHaveLength(0);
  });

  it('§18.1 replay: same bank transfer recorded twice collides — no new receipt, no new postings', async () => {
    const { service, ledgerRows, receipts } = harness({
      merchant: [merchantInvoice()],
    });
    await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 2000,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-19T10:00:00.000Z',
    });
    const replay = await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 2000,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-19T10:00:00.000Z',
    });
    expect(replay.replayed).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(ledgerRows).toHaveLength(2); // unchanged
  });

  it('a REUSED bank reference with different money is refused loudly, never swallowed (review finding 4)', async () => {
    const { service } = harness({ merchant: [merchantInvoice()] });
    await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 2000,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-19T10:00:00.000Z',
    });
    await expect(
      service.recordReceipt('fin-1', {
        invoiceType: 'merchant_invoice',
        invoiceId: 'minv-1',
        amount: 3750, // DIFFERENT transfer, same reference — data entry error
        bankReference: 'TT-9001',
        receivedAt: '2026-07-20T14:30:00.000Z',
      }),
    ).rejects.toThrow('receipt_reference_conflict');
  });

  it('the receipt transaction is SERIALIZABLE with in-tx guards, and P2034 conflicts retry (review finding 1)', async () => {
    const { service, prisma } = harness({ merchant: [merchantInvoice()] });
    // First call fails with a serialization conflict; the retry runs
    // its guards again and succeeds.
    let calls = 0;
    (prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (tx: unknown) => unknown, opts: unknown) => {
        expect(opts).toEqual({ isolationLevel: 'Serializable' });
        if (++calls === 1) {
          return Promise.reject(
            Object.assign(new Error('serialization'), { code: 'P2034' }),
          );
        }
        return fn(prisma);
      },
    );
    const res = await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 5750,
      bankReference: 'TT-1',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    expect(res.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('replaying the completing receipt HEALS a crash between commit and coverage flip (review finding 3)', async () => {
    const { service, merch, items } = harness({ merchant: [merchantInvoice()] });
    await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 5750,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    // Simulate the crash: flip lost, artifacts missing.
    merch.get('minv-1')!.status = 'issued';
    items.length = 0;
    // The operator's natural move — retry the SAME receipt.
    const replay = await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 5750,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.coverage!.covered).toBe(true);
    expect(merch.get('minv-1')!.status).toBe('paid');
    expect(items).toHaveLength(1);
  });

  it('deriveAndApplyCoverage is idempotent and HEALS a missed flip (concurrent-receipts race)', async () => {
    const { service, merch, items, ledgerRows } = harness({
      merchant: [merchantInvoice()],
    });
    await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 5750,
      bankReference: 'TT-9001',
      receivedAt: '2026-07-20T10:00:00.000Z',
    });
    // Simulate the lost race: force the invoice back to issued with
    // artifacts missing, then re-derive.
    merch.get('minv-1')!.status = 'issued';
    items.length = 0;
    const healed = await service.deriveAndApplyCoverage(
      'fin-1',
      'merchant_invoice',
      'minv-1',
    );
    expect(healed.covered).toBe(true);
    expect(merch.get('minv-1')!.status).toBe('paid');
    expect(items).toHaveLength(1);
    // Replaying derive again changes nothing (postings collide).
    const before = ledgerRows.length;
    await service.deriveAndApplyCoverage('fin-1', 'merchant_invoice', 'minv-1');
    expect(ledgerRows.length).toBe(before);
    expect(items).toHaveLength(1);
  });

  it('receivables aging: open balances bucketed off the injected clock, covered invoices excluded', async () => {
    const { service } = harness({
      merchant: [
        merchantInvoice(), // due 2026-07-15, clock 2026-07-21 → 6 days
        merchantInvoice({
          id: 'minv-2',
          campaignId: 'camp-2',
          dueDate: new Date('2026-05-01T00:00:00.000Z'), // 81 days
          totalAmount: 1000,
        }),
      ],
      corporate: [corporateInvoice({ dueDate: null })],
    });
    await service.recordReceipt('fin-1', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 750,
      bankReference: 'TT-1',
      receivedAt: '2026-07-19T10:00:00.000Z',
    });
    const aging = await service.receivablesAging();
    expect(aging.asOf).toBe('2026-07-21T09:00:00.000Z');
    const byId = Object.fromEntries(aging.items.map((i) => [i.invoiceId, i]));
    expect(byId['minv-1']).toMatchObject({
      balance: 5000,
      amountReceived: 750,
      daysOverdue: 6,
      bucket: '1-30',
    });
    expect(byId['minv-2']).toMatchObject({ daysOverdue: 81, bucket: '61-90' });
    expect(byId['cinv-1']).toMatchObject({
      balance: 172.5,
      daysOverdue: 0,
      bucket: 'current',
    });
  });
});
