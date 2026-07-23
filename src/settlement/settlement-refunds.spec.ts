// SETTLE-3a refunds — unit pins (Track C PR 5).
//
// SC §8 executable: allocation follows the seller of the leg (goods
// only at pilot — the fee leg refuses), credit-note documents,
// frozen-proportion VAT reversal, the §8.4 settlement interactions
// (reduce | refuse-bound | receivable), the over-refund guard, and
// §18.1 evidence-identity replay.

import { SettlementRefundsService } from './settlement-refunds.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const NOW = '2026-07-22T12:00:00.000Z';

function world(opts?: {
  itemState?: string;
  itemAmount?: number;
  receipts?: number[];
  invoiceStatus?: string;
  invoiceTotal?: number;
  invoiceVat?: number;
}) {
  let seq = 0;
  const invoice: Row = {
    id: 'minv-1',
    status: opts?.invoiceStatus ?? 'paid',
    totalAmount: opts?.invoiceTotal ?? 5750,
    vatAmount: opts?.invoiceVat ?? 750,
    currency: 'SAR',
    orgId: 'org-1',
    campaignId: 'camp-1',
    storeId: 's-1',
    merchantInvoiceNumber: 'DAT-2026-0042',
  };
  const item: Row = {
    id: 'i-1',
    occurrenceType: 'merchant_invoice',
    occurrenceId: 'minv-1',
    storeId: 's-1',
    currency: 'SAR',
    amount: opts?.itemAmount ?? 5750,
    state: opts?.itemState ?? 'eligible',
    batchId: null,
  };
  const refunds: Row[] = [];
  const noteVersions: Row[] = [];
  const creditNotes: Row[] = [];
  const receivables: Row[] = [];
  const ledgerRows: Row[] = [];
  const auditRows: Row[] = [];
  const prisma = {
    merchantInvoice: {
      findUnique: jest.fn().mockResolvedValue(invoice),
    },
    paymentReceipt: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (opts?.receipts ?? [5750]).map((amount) => ({ amount })),
        ),
    },
    settlementRefund: {
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where as Row)
          .invoiceType_invoiceId_evidenceRef as Row;
        return Promise.resolve(
          refunds.find(
            (r) =>
              r.invoiceType === w.invoiceType &&
              r.invoiceId === w.invoiceId &&
              r.evidenceRef === w.evidenceRef,
          ) ?? null,
        );
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) =>
        Promise.resolve(
          refunds.filter(
            (r) => r.invoiceId === (where as Row).invoiceId,
          ),
        ),
      ),
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = { id: `ref-${++seq}`, ...(data as Row) };
        refunds.push(row);
        return Promise.resolve(row);
      }),
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
      create: jest.fn().mockImplementation(({ data }: never) => {
        // Model Prisma's nullable-column default.
        const row = {
          id: `cn-${++seq}`,
          statementSettlementId: null,
          qiftCreditNoteNumber: null,
          netComponent: null,
          reasonCode: null,
          taxRuleVersion: null,
          buyerSnapshot: null,
          issuerSnapshot: null,
          creditNoteUuid: null,
          ...(data as Row),
        };
        creditNotes.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { referenceNumber?: string; refundId?: string };
        return Promise.resolve(
          creditNotes.find(
            (c) =>
              (w.referenceNumber !== undefined &&
                c.referenceNumber === w.referenceNumber) ||
              (w.refundId !== undefined && c.refundId === w.refundId),
          ) ?? null,
        );
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    settlementItem: {
      findUnique: jest.fn().mockResolvedValue(item),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as Row;
        if (
          item.id !== w.id ||
          (w.state !== undefined && item.state !== w.state) ||
          (w.batchId !== undefined && item.batchId !== w.batchId)
        ) {
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
      findMany: jest.fn().mockImplementation(() => Promise.resolve(receivables)),
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
    recordGuaranteed: jest.fn().mockImplementation((row: Row) => {
      auditRows.push(row);
      return Promise.resolve(undefined);
    }),
  };
  const ledger = {
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
  const service = new SettlementRefundsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledger as unknown as FinancialLedgerService,
    { now: () => new Date(NOW) },
    { deriveAndApplyCoverage: jest.fn().mockResolvedValue({}) } as never,
  );
  return {
    service,
    prisma,
    invoice,
    item,
    refunds,
    creditNotes,
    receivables,
    ledgerRows,
    auditRows,
  };
}

const INPUT = (over: Partial<Row> = {}) => ({
  invoiceType: 'merchant_invoice' as const,
  invoiceId: 'minv-1',
  amount: 1150,
  reason: 'two units returned damaged',
  evidenceRef: 'BANK-REF-OUT-5001',
  refundedAt: '2026-07-22T10:00:00.000Z',
  ...over,
});

describe('SettlementRefundsService (SETTLE-3a, §8)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('§8.1 the fee leg routes to the QIFT branch — its own vocabulary, never the goods path', async () => {
    const { service } = world();
    // SETTLE-3c-1: the fee leg is live and demands ITS closed reason
    // vocabulary before anything else — proof the goods path (which
    // spends merchant money) is never entered.
    await expect(
      service.recordRefund('fin-1', INPUT({ invoiceType: 'corporate_invoice' } as never)),
    ).rejects.toThrow('fee_refund_reason_code_required');
  });

  it('input law: gates, evidence, reason, amount, value-date window, paid invoice', async () => {
    delete process.env[GATES_ENV];
    try {
      await expect(
        world().service.recordRefund('fin-1', INPUT()),
      ).rejects.toThrow('financial_gates_not_attested');
    } finally {
      process.env[GATES_ENV] = 'true';
    }
    const { service } = world();
    await expect(
      service.recordRefund('fin-1', INPUT({ evidenceRef: ' ' } as never)),
    ).rejects.toThrow('refund_evidence_required');
    await expect(
      service.recordRefund('fin-1', INPUT({ reason: '' } as never)),
    ).rejects.toThrow('refund_reason_required');
    await expect(
      service.recordRefund('fin-1', INPUT({ amount: 0 } as never)),
    ).rejects.toThrow('refund_amount_must_be_positive');
    await expect(
      service.recordRefund('fin-1', INPUT({ refundedAt: '2026-07-01T00:00:00.000Z' } as never)),
    ).rejects.toThrow('refund_refunded_at_out_of_window');
    await expect(
      world({ invoiceStatus: 'issued' }).service.recordRefund(
        'fin-1',
        INPUT(),
      ),
    ).rejects.toThrow('refund_requires_paid_invoice:issued');
  });

  it('over-refund is impossible: Σ refunds never exceeds Σ receipts (minor units)', async () => {
    const { service } = world();
    await service.recordRefund('fin-1', INPUT({ amount: 5000 } as never));
    await expect(
      service.recordRefund(
        'fin-1',
        INPUT({ amount: 750.01, evidenceRef: 'BANK-REF-OUT-5002' } as never),
      ),
    ).rejects.toThrow('refund_exceeds_collected');
  });

  it('§8.3 VAT reverses at the FROZEN proportion, half-up in minor units', async () => {
    const { service, refunds, creditNotes } = world();
    // 1,150 of a 5,750 invoice carrying 750 VAT → 150.00 exactly.
    await service.recordRefund('fin-1', INPUT());
    expect(refunds[0].vatComponent).toBe(150);
    expect(creditNotes[0].vatComponent).toBe(150);
    // Rounding pin: 0.10 → 10 * 75000 / 575000 = 1.304… → 1 halala.
    const w2 = world();
    await w2.service.recordRefund(
      'fin-1',
      INPUT({ amount: 0.1, evidenceRef: 'BANK-REF-OUT-5003' } as never),
    );
    expect(w2.refunds[0].vatComponent).toBe(0.01);
  });

  it('§8.4 pre-settlement: the item REDUCES (guarded), refund.paid posts inside the tx, credit note issued', async () => {
    const { service, item, refunds, creditNotes, ledgerRows, receivables, auditRows } =
      world();
    const res = await service.recordRefund('fin-1', INPUT());
    expect(res.replayed).toBe(false);
    expect(item.amount).toBe(4600); // 5,750 − 1,150
    expect(refunds[0]).toMatchObject({
      settlementInteraction: 'item_reduced',
      amount: 1150,
    });
    expect(creditNotes[0]).toMatchObject({
      noteType: 'merchant_goods',
      merchantInvoiceNumber: 'DAT-2026-0042', // quoted, never manufactured
      merchantCreditNoteNumber: null,
      amount: 1150,
    });
    const paid = ledgerRows.find((r) => r.eventType === 'refund.paid')!;
    expect(paid).toMatchObject({
      amount: 1150,
      direction: 'debit',
      insideTx: true,
      idempotencyKey: `refund.paid:${refunds[0].id}`,
    });
    expect((paid.metadata as Row).account).toBe('safeguarding');
    expect(receivables).toHaveLength(0); // money never left — no clawback
    expect(
      auditRows.find((a) => a.action === 'finance.refund.recorded'),
    ).toBeTruthy();
  });

  it('§8.4/§33.3 an item bound to a ready batch REFUSES — supersession first, never batch surgery', async () => {
    const w = world({ itemState: 'ready' });
    w.item.batchId = 'stl-1';
    await expect(w.service.recordRefund('fin-1', INPUT())).rejects.toThrow(
      'item_bound_supersede_first',
    );
    await expect(
      world({ itemState: 'disputed' }).service.recordRefund('fin-1', INPUT()),
    ).rejects.toThrow('item_disputed');
  });

  it('§8.4/§2 post-settlement: receivable accrues; partial keeps the item settled; full clawback flips Reversed', async () => {
    const w = world({ itemState: 'settled' });
    await w.service.recordRefund('fin-1', INPUT()); // 1,150 partial
    expect(w.receivables).toHaveLength(1);
    expect(w.receivables[0]).toMatchObject({
      amount: 1150,
      state: 'open',
      occurrenceType: 'refund',
    });
    const accrued = w.ledgerRows.find(
      (r) => r.eventType === 'merchant.receivable.accrued',
    )!;
    expect(accrued).toMatchObject({ amount: 1150, direction: 'credit' });
    expect(w.item.state).toBe('settled'); // partial — receivable carries it
    // Claw back the remainder → the settled item flips Reversed.
    await w.service.recordRefund(
      'fin-1',
      INPUT({ amount: 4600, evidenceRef: 'BANK-REF-OUT-5002' } as never),
    );
    expect(w.item.state).toBe('reversed');
    expect(w.receivables).toHaveLength(2);
  });

  it('§18.1 replay: identical evidence collides quietly; different money under the same reference refuses', async () => {
    const { service, refunds, ledgerRows } = world();
    await service.recordRefund('fin-1', INPUT());
    const replay = await service.recordRefund('fin-1', INPUT());
    expect(replay.replayed).toBe(true);
    expect(refunds).toHaveLength(1);
    expect(ledgerRows).toHaveLength(1);
    await expect(
      service.recordRefund('fin-1', INPUT({ amount: 999 } as never)),
    ).rejects.toThrow('refund_evidence_conflict');
  });

  it('review finding 2: the Reversed flip counts POST-settlement clawbacks only — mixed histories never flip early', async () => {
    // Invoice 5,750 paid; 1,150 was refunded PRE-settlement (item
    // shrank to 4,600 and settled at 4,600).
    const w = world({ itemState: 'settled', itemAmount: 4600 });
    w.refunds.push({
      id: 'ref-pre',
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 1150,
      vatComponent: 150,
      evidenceRef: 'BANK-REF-OUT-4999',
      refundedAt: new Date('2026-07-21T10:00:00.000Z'),
      settlementInteraction: 'item_reduced',
    });
    await w.service.recordRefund('fin-1', INPUT({ amount: 2000 } as never));
    expect(w.item.state).toBe('settled'); // clawed 2,000 of 4,600
    await w.service.recordRefund(
      'fin-1',
      INPUT({ amount: 1450, evidenceRef: 'BANK-REF-OUT-5002' } as never),
    );
    // Σ post-settlement clawbacks = 3,450 < 4,600 — the OLD condition
    // (all refunds ≥ item) would have flipped here. It must NOT.
    expect(w.item.state).toBe('settled');
    await w.service.recordRefund(
      'fin-1',
      INPUT({ amount: 1150, evidenceRef: 'BANK-REF-OUT-5003' } as never),
    );
    // Now 4,600 of 4,600 settled money clawed back → Reversed.
    expect(w.item.state).toBe('reversed');
    expect(w.receivables).toHaveLength(3);
  });

  it('review finding 3: concurrent identical submissions resolve as §18.1 replay, never a 500', async () => {
    const w = world();
    // Simulate the race: the in-tx replay read misses, the insert
    // collides; the outer identity lookup then finds the winner.
    const row = {
      id: 'ref-winner',
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 1150,
      vatComponent: 150,
      evidenceRef: 'BANK-REF-OUT-5001',
      refundedAt: new Date('2026-07-22T10:00:00.000Z'),
      settlementInteraction: 'item_reduced',
    };
    let calls = 0;
    (w.prisma.settlementRefund.findUnique as jest.Mock).mockImplementation(
      () => Promise.resolve(++calls === 1 ? null : row),
    );
    (w.prisma.settlementRefund.create as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    const res = await w.service.recordRefund('fin-1', INPUT());
    expect(res.replayed).toBe(true);
    // ...and a DIFFERENT movement under the same reference refuses.
    calls = 1; // next findUnique returns the winner again
    (w.prisma.settlementRefund.create as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      w.service.recordRefund('fin-1', INPUT({ amount: 999 } as never)),
    ).rejects.toThrow('refund_evidence_conflict');
  });

  it('review finding 4: Σ credit-note VAT across split refunds is CAPPED at the frozen invoice VAT', async () => {
    // total 200, VAT 100 — refunded as 101 + 99. Independent half-up
    // would give 50.50 + 49.55 = 100.05; the cap yields 50.50 + 49.50.
    const w = world({
      invoiceTotal: 200,
      invoiceVat: 100,
      itemAmount: 200,
      receipts: [200],
    });
    await w.service.recordRefund('fin-1', INPUT({ amount: 101 } as never));
    expect(w.refunds[0].vatComponent).toBe(50.5);
    await w.service.recordRefund(
      'fin-1',
      INPUT({ amount: 99, evidenceRef: 'BANK-REF-OUT-5002' } as never),
    );
    expect(w.refunds[1].vatComponent).toBe(49.5);
  });

  it('RC v3.0: the issued credit note carries QN + canonical JSON + hash-from-canonical, and REPLAYS identically', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT());
    const note = w.creditNotes[0];
    expect(note.referenceNumber).toMatch(
      /^QN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
    );
    expect(typeof note.canonicalJson).toBe('string');
    expect(
      w.auditRows.find((a) => a.action === 'finance.credit_note.issued'),
    ).toBeTruthy();
    const replay = await w.service.replayCreditNote('fin-1', note.refundId as string);
    expect(replay).toMatchObject({
      identical: true,
      canonicalIdentical: true,
      hashIdentical: true,
      documentVersion: 'v3',
    });
    expect(replay.creditNoteReference).toBe(note.referenceNumber);
    expect(
      w.auditRows.find((a) => a.action === 'settlement.credit_note.replayed'),
    ).toBeTruthy();
    // Tampering the stored canonical SURFACES — never renders as authentic.
    note.canonicalJson = '{"tampered":true}';
    const bad = await w.service.replayCreditNote('fin-1', note.refundId as string);
    expect(bad.identical).toBe(false);
    expect(bad.canonicalIdentical).toBe(false);
  });

  it('read models: refunds+credit notes per invoice; open receivables per store', async () => {
    const w = world({ itemState: 'settled' });
    await w.service.recordRefund('fin-1', INPUT());
    const listed = await w.service.listRefunds('merchant_invoice', 'minv-1');
    expect(listed.refunds).toHaveLength(1);
    const open = await w.service.openReceivables('s-1');
    expect(open.asOf).toBe(NOW);
    expect(open.receivables).toHaveLength(1);
  });
});
