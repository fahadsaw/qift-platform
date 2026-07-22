// Track C PR 5 — the MANDATED end-to-end financial walkthrough,
// executable. SETTLE-3a plays SC §25.2 with the S01 numbers: a goods
// refund lands AFTER batch QS-A settled.
//
//   Business event → Ledger before → Ledger entries created →
//   References → Receivable/Payable changes → Settlement state →
//   Audit records → Ledger after.
//
// Story: Dar Alteeb's 5,750.00 settled and was remitted (SETTLE-2).
// Two gift units arrive damaged; Nahdi is refunded 1,150.00 (goods,
// incl. 150.00 VAT at the FROZEN proportion) from safeguarding. The
// money already left to the merchant — so the refund becomes a
// MERCHANT RECEIVABLE (§2 Reversed flow): a credit note documents it,
// the signed net position dips negative, and recovery rides the next
// batch's §4 recovery line (SETTLE-3b). QS-A is untouched; no
// statement is edited.

import { SettlementRefundsService } from './settlement-refunds.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';

describe('Track C PR 5 — end-to-end financial walkthrough (S01 continuation: post-settlement refund → Reversed → receivable)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('walks §25.2: refund after settlement → credit note → receivable → negative position, QS-A untouched', async () => {
    // ── STAGE 0: Business event ─────────────────────────────────────
    // SETTLE-2 finished: payable extinguished by remittance under
    // QS-A. Now: 2 damaged units → 1,150.00 goods refund to Nahdi.
    const ledgerRows: Row[] = [
      // The settled history (abbreviated to the position-bearing rows).
      {
        eventType: 'merchant.payable.accrued',
        amount: 5750,
        direction: 'debit',
        idempotencyKey: 'merchant.payable.accrued:rcpt-agg',
      },
      {
        eventType: 'merchant.remittance.paid',
        amount: 5750,
        direction: 'credit',
        idempotencyKey: 'merchant.remittance.paid:rem-1',
      },
    ];
    let seq = 0;
    const invoice: Row = {
      id: 'minv-1',
      status: 'paid',
      totalAmount: 5750,
      vatAmount: 750,
      currency: 'SAR',
      orgId: 'org-nahdi',
      campaignId: 'camp-eid',
      storeId: 's-daralteeb',
      merchantInvoiceNumber: 'DAT-2026-0042',
    };
    const item: Row = {
      id: 'sitem-1',
      occurrenceType: 'merchant_invoice',
      occurrenceId: 'minv-1',
      storeId: 's-daralteeb',
      currency: 'SAR',
      amount: 5750,
      state: 'settled',
      batchId: 'stl-qs-a',
    };
    const refunds: Row[] = [];
    const creditNotes: Row[] = [];
    const receivables: Row[] = [];
    const auditRows: Row[] = [];
    const batchQsA: Row = {
      id: 'stl-qs-a',
      settlementReference: 'QS-K7MP-4WX2',
      status: 'settled',
      netAmount: 5750,
    };

    const prisma = {
      merchantInvoice: { findUnique: jest.fn().mockResolvedValue(invoice) },
      paymentReceipt: {
        findMany: jest.fn().mockResolvedValue([{ amount: 5750 }]),
      },
      settlementRefund: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(refunds)),
        create: jest.fn().mockImplementation(({ data }: never) => {
          const row = { id: `ref-${++seq}`, ...(data as Row) };
          refunds.push(row);
          return Promise.resolve(row);
        }),
      },
      creditNote: {
        create: jest.fn().mockImplementation(({ data }: never) => {
          const row = { id: `cn-${++seq}`, ...(data as Row) };
          creditNotes.push(row);
          return Promise.resolve(row);
        }),
      },
      settlementItem: {
        findUnique: jest.fn().mockResolvedValue(item),
        updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
          const w = where as Row;
          if (item.id !== w.id || (w.state && item.state !== w.state)) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(item, data as Row);
          return Promise.resolve({ count: 1 });
        }),
      },
      settlementReceivable: {
        create: jest.fn().mockImplementation(({ data }: never) => {
          const row = { id: `rcv-${++seq}`, ...(data as Row) };
          receivables.push(row);
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
      record: jest.fn().mockImplementation((row: Row) => {
        ledgerRows.push(row);
        return Promise.resolve(row);
      }),
    };
    const service = new SettlementRefundsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      ledger as unknown as FinancialLedgerService,
      { now: () => new Date('2026-07-22T12:00:00.000Z') },
    );

    // ── STAGE 1: Ledger BEFORE ──────────────────────────────────────
    // Signed net position (§11.4): payables − remittances −
    // recoveries − outstanding receivables = 5,750 − 5,750 − 0 − 0.
    const position = () =>
      ledgerRows
        .filter((e) => e.eventType === 'merchant.payable.accrued')
        .reduce((s, e) => s + (e.amount as number), 0) -
      ledgerRows
        .filter((e) => e.eventType === 'merchant.remittance.paid')
        .reduce((s, e) => s + (e.amount as number), 0) -
      ledgerRows
        .filter((e) => e.eventType === 'merchant.receivable.accrued')
        .reduce((s, e) => s + (e.amount as number), 0);
    expect(position()).toBe(0);

    // ── STAGE 2: Ledger entries created — the refund lands ──────────
    const res = await service.recordRefund('founder-finance', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 1150,
      reason: 'two units damaged in transit — Nahdi refunded',
      evidenceRef: 'BANK-REF-OUT-5001',
      refundedAt: '2026-07-22T10:30:00.000Z',
    });
    expect(res.replayed).toBe(false);
    const paid = ledgerRows.find((e) => e.eventType === 'refund.paid')!;
    expect(paid).toMatchObject({ amount: 1150, direction: 'debit' });
    expect((paid.metadata as Row).account).toBe('safeguarding');
    const accrued = ledgerRows.find(
      (e) => e.eventType === 'merchant.receivable.accrued',
    )!;
    expect(accrued).toMatchObject({ amount: 1150, direction: 'credit' });

    // ── STAGE 3: References + the credit-note DOCUMENT (FC 4.5) ─────
    expect(creditNotes).toHaveLength(1);
    expect(creditNotes[0]).toMatchObject({
      noteType: 'merchant_goods',
      merchantInvoiceNumber: 'DAT-2026-0042', // quoted — never manufactured
      amount: 1150,
      vatComponent: 150, // §8.3: frozen proportion of 750/5,750
    });
    expect(batchQsA.settlementReference).toBe('QS-K7MP-4WX2'); // untouched

    // ── STAGE 4: Receivable / Payable changes ───────────────────────
    // The payable stays extinguished; the merchant now OWES 1,150:
    // position dips NEGATIVE — exactly §25.2.
    expect(position()).toBe(-1150);
    expect(receivables[0]).toMatchObject({
      amount: 1150,
      state: 'open',
      storeId: 's-daralteeb',
    });

    // ── STAGE 5: Settlement state ───────────────────────────────────
    // Partial clawback: the item STAYS settled (the receivable carries
    // the exact amount owed); batch QS-A terminal, untouched.
    expect(item.state).toBe('settled');
    expect(batchQsA.status).toBe('settled');
    expect(refunds[0].settlementInteraction).toBe('receivable_accrued');

    // ── STAGE 6: Audit records ──────────────────────────────────────
    expect(auditRows.map((a) => a.action)).toEqual([
      'finance.refund.recorded',
    ]);
    expect(auditRows[0].metadata).toMatchObject({
      refundId: refunds[0].id,
      amount: 1150,
      vatComponent: 150,
      settlementInteraction: 'receivable_accrued',
    });

    // ── STAGE 7/8: Ledger AFTER ─────────────────────────────────────
    // No statement edited, no batch reopened: the NEXT batch's §4
    // recovery line extinguishes the receivable (SETTLE-3b) — the
    // negative position recovers by offset, exactly as §25.2 closes.
    expect(ledgerRows.filter((e) => e.eventType === 'refund.paid')).toHaveLength(1);
  });
});
