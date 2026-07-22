// SETTLE-3c-1 — Qift service-fee refunds + Qift-issued credit notes
// (Track C PR 9). The founder-mandated proofs AND the 12-step
// walkthrough. The FROZEN Qift invoice is the only source of truth —
// no live engine is ever consulted (the harness has no fee/tax engine
// at all: recomputation is structurally impossible here).

import { SettlementRefundsService } from './settlement-refunds.service';
import {
  creditNoteCanonical,
  creditNoteHash,
  type CreditNoteFacts,
} from './settlement-credit-note';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const NOW = '2026-07-23T12:00:00.000Z';

function world(opts?: { invoiceStatus?: string; receipts?: number[] }) {
  let seq = 0;
  let seriesValue = 0;
  const invoice: Row = {
    id: 'cinv-1',
    invoiceNumber: 'QC-2026-00001',
    status: opts?.invoiceStatus ?? 'paid',
    totalAmount: 172.5,
    vatAmount: 22.5,
    platformFeeAmount: 150,
    currency: 'SAR',
    orgId: 'org-nahdi',
    campaignId: 'camp-eid',
    taxSnapshot: { ruleVersion: 'sa-vat-agent-v3' },
    buyerSnapshot: { legalName: 'Nahdi Trading LLC', vatNumber: '310123456700003' },
    sellerSnapshot: { legalName: 'Qift Information Technology', vatNumber: '311987654300003' },
  };
  const refunds: Row[] = [];
  const creditNotes: Row[] = [];
  const noteVersions: Row[] = [];
  const ledgerRows: Row[] = [];
  const auditRows: Row[] = [];
  const prisma = {
    corporateInvoice: { findUnique: jest.fn().mockResolvedValue(invoice) },
    paymentReceipt: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (opts?.receipts ?? (opts?.invoiceStatus === 'issued' ? [] : [172.5])).map(
            (amount) => ({ amount }),
          ),
        ),
    },
    settlementRefund: {
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where as Row).invoiceType_invoiceId_evidenceRef as Row;
        return Promise.resolve(
          refunds.find(
            (r) =>
              r.invoiceType === w.invoiceType &&
              r.invoiceId === w.invoiceId &&
              r.evidenceRef === w.evidenceRef,
          ) ?? null,
        );
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as Row;
        return Promise.resolve(
          refunds.filter(
            (r) =>
              r.invoiceId === w.invoiceId &&
              (w.settlementInteraction === undefined ||
                r.settlementInteraction === w.settlementInteraction),
          ),
        );
      }),
      create: jest.fn().mockImplementation(({ data }: never) => {
        const d = data as Row;
        if (
          refunds.some(
            (r) =>
              r.invoiceType === d.invoiceType &&
              r.invoiceId === d.invoiceId &&
              r.evidenceRef === d.evidenceRef,
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row = { id: `ref-${++seq}`, ...d };
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
    },
    creditNote: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row = {
          id: `cn-${++seq}`,
          statementSettlementId: null,
          ...(data as Row),
        };
        creditNotes.push(row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { referenceNumber?: string; refundId?: string };
        const found = creditNotes.find(
          (c) =>
            (w.referenceNumber !== undefined &&
              c.referenceNumber === w.referenceNumber) ||
            (w.refundId !== undefined && c.refundId === w.refundId),
        );
        return Promise.resolve(found ? { ...found } : null);
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // The agent-model pin: these exist ONLY to prove they are never
    // touched by the fee leg.
    settlementItem: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    settlementReceivable: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    merchantInvoice: { findUnique: jest.fn() },
    $queryRaw: jest.fn().mockImplementation(() => {
      seriesValue += 1;
      return Promise.resolve([{ lastValue: seriesValue }]);
    }),
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
  const receiptsStub = {
    deriveAndApplyCoverage: jest.fn().mockResolvedValue({}),
  };
  const service = new SettlementRefundsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledger as unknown as FinancialLedgerService,
    { now: () => new Date(NOW) },
    receiptsStub as never,
  );
  return {
    service,
    prisma,
    invoice,
    refunds,
    creditNotes,
    noteVersions,
    ledgerRows,
    auditRows,
    receiptsStub,
  };
}

const INPUT = (over: Row = {}) => ({
  invoiceType: 'corporate_invoice' as const,
  invoiceId: 'cinv-1',
  amount: 57.5,
  reason: 'one recipient bucket cancelled before dispatch',
  reasonCode: 'billing_error',
  evidenceRef: 'BANK-REF-OUT-7001',
  refundedAt: '2026-07-23T10:00:00.000Z',
  ...over,
});

describe('SETTLE-3c-1 — Qift service-fee refunds (founder proofs)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('QN is NOT the legal number: QD is — sequential, Qift-owned, distinct from QN and from any merchant series', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const note = w.creditNotes[0];
    expect(note.referenceNumber).toMatch(/^QN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(note.qiftCreditNoteNumber).toBe('QD-2026-00001');
    expect(note.referenceNumber).not.toBe(note.qiftCreditNoteNumber);
    expect(note.merchantCreditNoteNumber).toBeNull(); // series never mix
    expect(note.merchantInvoiceNumber).toBeNull();
  });

  it('series separation: a merchant number or on-behalf evidence on the FEE leg refuses', async () => {
    const w = world();
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({ merchantCreditNoteNumber: 'DAT-CN-1' }) as never,
      ),
    ).rejects.toThrow(
      'credit_note_series_separation:fee_leg_never_merchant_series',
    );
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({ onBehalfAuthorizationRef: 'CONTRACT-X' }) as never,
      ),
    ).rejects.toThrow('credit_note_series_separation');
  });

  it('original-invoice linkage and refund reason are MANDATORY and frozen into the document', async () => {
    const w = world();
    await expect(
      w.service.recordRefund('fin-1', INPUT({ reasonCode: undefined }) as never),
    ).rejects.toThrow('fee_refund_reason_code_required');
    await expect(
      w.service.recordRefund('fin-1', INPUT({ reasonCode: 'made_up' }) as never),
    ).rejects.toThrow('fee_refund_reason_code_required');
    await expect(
      w.service.recordRefund('fin-1', INPUT({ reason: ' ' }) as never),
    ).rejects.toThrow('refund_reason_required');
    await w.service.recordRefund('fin-1', INPUT() as never);
    const note = w.creditNotes[0];
    expect(note).toMatchObject({
      issuerType: 'QIFT',
      issuanceSource: 'QIFT',
      invoiceId: 'cinv-1',
      originalInvoiceNumber: 'QC-2026-00001',
      reasonCode: 'billing_error',
      taxRuleVersion: 'sa-vat-agent-v3', // FROZEN from the invoice
    });
    expect(note.canonicalJson).toContain('"originalInvoiceNumber":"QC-2026-00001"');
    expect(note.canonicalJson).toContain('"reasonCode":"billing_error"');
  });

  it('full refund, partial refunds, multiple partials — exact minor-unit arithmetic; over-refund refuses', async () => {
    // Three exact thirds: 57.50 each of 172.50 (VAT 7.50 each of 22.50).
    const w = world();
    for (const [i, ref] of ['A', 'B', 'C'].entries()) {
      const res = await w.service.recordRefund(
        'fin-1',
        INPUT({ evidenceRef: `BANK-REF-OUT-700${i}` }) as never,
      );
      expect(res.replayed).toBe(false);
      expect(w.creditNotes[i]).toMatchObject({
        amount: 57.5,
        vatComponent: 7.5,
        netComponent: 50,
        qiftCreditNoteNumber: `QD-2026-0000${i + 1}`, // gap-free series
      });
    }
    // Cumulative cap: one more halala over the invoice total refuses.
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({ amount: 0.01, evidenceRef: 'BANK-REF-OUT-7009' }) as never,
      ),
    ).rejects.toThrow('refund_exceeds_invoice');
    // Σ VAT components = exactly the frozen invoice VAT.
    expect(
      w.creditNotes.reduce((t, n) => t + (n.vatComponent as number), 0),
    ).toBe(22.5);
  });

  it('review finding 4: the COMPLETING refund absorbs the VAT remainder — a full refund in parts reverses the frozen VAT exactly', async () => {
    const w = world();
    w.invoice.totalAmount = 23;
    w.invoice.vatAmount = 3;
    w.invoice.platformFeeAmount = 20;
    (w.prisma.paymentReceipt.findMany as jest.Mock).mockResolvedValue([
      { amount: 23 },
    ]);
    for (const [i, amount] of [7, 7, 9].entries()) {
      await w.service.recordRefund(
        'fin-1',
        INPUT({ amount, evidenceRef: `BANK-REF-OUT-71${i}` }) as never,
      );
    }
    expect(w.creditNotes.map((n) => n.vatComponent)).toEqual([0.91, 0.91, 1.18]);
    expect(
      w.creditNotes.reduce((t, n) => t + (n.vatComponent as number), 0),
    ).toBe(3); // frozen VAT reversed EXACTLY
    // Σ nets = 20.00 = recognized net; no negative-revenue drift.
    expect(
      w.creditNotes.reduce((t, n) => t + (n.netComponent as number), 0),
    ).toBe(20);
  });

  it('review finding 2: a pre-payment credit re-derives coverage (the completing credit closes the invoice)', async () => {
    const w = world({ invoiceStatus: 'issued', receipts: [100] });
    await w.service.recordRefund('fin-1', INPUT() as never);
    // The refunds service handed coverage back to the receipts seam.
    expect(
      (w.receiptsStub.deriveAndApplyCoverage as jest.Mock).mock.calls,
    ).toEqual([['fin-1', 'corporate_invoice', 'cinv-1']]);
  });

  it('concurrent duplicate submission resolves by §18.1 identity — never a 500, never double money', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const replay = await w.service.recordRefund('fin-1', INPUT() as never);
    expect(replay.replayed).toBe(true);
    expect(w.refunds).toHaveLength(1);
    expect(w.creditNotes).toHaveLength(1);
    // Different money under the same reference refuses loudly.
    await expect(
      w.service.recordRefund('fin-1', INPUT({ amount: 10 }) as never),
    ).rejects.toThrow('refund_evidence_conflict');
    // Insert-race lane: in-tx read misses, create collides → replay.
    const w2 = world();
    let calls = 0;
    (w2.prisma.settlementRefund.findUnique as jest.Mock).mockImplementation(
      () =>
        Promise.resolve(
          ++calls === 1
            ? null
            : {
                id: 'ref-winner',
                amount: 57.5,
                refundedAt: new Date('2026-07-23T10:00:00.000Z'),
              },
        ),
    );
    (w2.prisma.settlementRefund.create as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    const raced = await w2.service.recordRefund('fin-1', INPUT() as never);
    expect(raced.replayed).toBe(true);
  });

  it('POST-payment: cash out of OPERATING + compensating revenue reversal + VAT reversal at the frozen proportion', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const paid = w.ledgerRows.find((r) => r.eventType === 'refund.paid')!;
    expect(paid).toMatchObject({
      amount: 57.5,
      direction: 'debit',
      insideTx: true,
      idempotencyKey: `refund.paid:${w.refunds[0].id}`,
    });
    expect((paid.metadata as Row).account).toBe('operating');
    const rev = w.ledgerRows.find(
      (r) =>
        r.eventType === 'qift.revenue.recognized' &&
        (r.idempotencyKey as string).includes(':reversal:'),
    )!;
    expect(rev).toMatchObject({ amount: 50, direction: 'debit' });
    expect((rev.metadata as Row).compensates).toBe(
      'qift.revenue.recognized:cinv-1',
    );
    const vat = w.ledgerRows.find(
      (r) => (r.idempotencyKey as string).endsWith(':vat'),
    )!;
    expect(vat).toMatchObject({
      eventType: 'refund.approved',
      amount: 7.5,
      direction: 'debit',
    });
  });

  it('PRE-payment: the receivable shrinks (no cash), compensating against the issuance posting', async () => {
    // Partially paid (100 of 172.50) so the UNPAID-portion cap is
    // distinct from the whole-invoice cap.
    const w = world({ invoiceStatus: 'issued', receipts: [100] });
    await w.service.recordRefund('fin-1', INPUT() as never);
    expect(
      w.ledgerRows.find((r) => r.eventType === 'refund.paid'),
    ).toBeUndefined(); // NO cash pre-payment
    const approved = w.ledgerRows.find(
      (r) =>
        r.eventType === 'refund.approved' &&
        !(r.idempotencyKey as string).endsWith(':vat'),
    )!;
    expect(approved).toMatchObject({
      amount: 57.5,
      direction: 'debit',
      reasonCode: 'CORPORATE_RECEIVABLE',
    });
    expect((approved.metadata as Row).compensates).toBe(
      'corporate.invoice.issued:cinv-1',
    );
    expect(w.refunds[0].settlementInteraction).toBe('invoice_reduced');
    // Pre-payment cap: credits never exceed the UNPAID portion —
    // 57.50 credited of the 72.50 unpaid; 20 more would eat into
    // money the org already PAID (a cash-refund matter, not a credit).
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({ amount: 20, evidenceRef: 'BANK-REF-OUT-7002' }) as never,
      ),
    ).rejects.toThrow('refund_exceeds_unpaid_balance');
  });

  it('re-review N1: the full unwind — credit, then pay, then CASH refund of everything collected — is lawful', async () => {
    // Invoice 172.50; pre-payment credit 57.50; org paid the effective
    // 115.00; campaign collapses → Qift returns the 115.00 cash.
    const w = world({ receipts: [115] });
    w.refunds.push({
      id: 'ref-pre',
      invoiceType: 'corporate_invoice',
      invoiceId: 'cinv-1',
      amount: 57.5,
      vatComponent: 7.5,
      evidenceRef: 'BANK-REF-OUT-6999',
      refundedAt: new Date('2026-07-22T10:00:00.000Z'),
      settlementInteraction: 'invoice_reduced',
    });
    const res = await w.service.recordRefund(
      'fin-1',
      INPUT({ amount: 115, evidenceRef: 'BANK-REF-OUT-7005' }) as never,
    );
    expect(res.replayed).toBe(false);
    // Σ all refunds = 172.50 = total (cumulative cap exact); cash out
    // 115 = cash in 115 (cash cap exact). One more halala refuses.
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({ amount: 0.01, evidenceRef: 'BANK-REF-OUT-7006' }) as never,
      ),
    ).rejects.toThrow('refund_exceeds_invoice');
  });

  it('AGENT MODEL: zero MerchantPayable, zero MerchantReceivable, zero item/reserve impact — Qift money only', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    for (const ev of [
      'merchant.payable.accrued',
      'merchant.receivable.accrued',
      'merchant.receivable.recovered',
      'merchant.remittance.paid',
    ]) {
      expect(w.ledgerRows.filter((r) => r.eventType === ev)).toEqual([]);
    }
    expect(w.prisma.settlementItem.findUnique).not.toHaveBeenCalled();
    expect(w.prisma.settlementItem.updateMany).not.toHaveBeenCalled();
    expect(w.prisma.settlementReceivable.create).not.toHaveBeenCalled();
    expect(w.prisma.merchantInvoice.findUnique).not.toHaveBeenCalled();
  });

  it('historical versions remain byte-reproducible; replay verifies the document', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const note = w.creditNotes[0];
    expect(w.noteVersions[0]).toMatchObject({
      versionNumber: 1,
      changeReason: 'issued',
    });
    const facts = {
      referenceNumber: note.referenceNumber,
      refundId: note.refundId,
      noteType: 'qift_service_fee',
      invoiceType: 'corporate_invoice',
      invoiceId: 'cinv-1',
      merchantInvoiceNumber: null,
      merchantCreditNoteNumber: null,
      issuerType: 'QIFT',
      issuanceSource: 'QIFT',
      onBehalfAuthorizationRef: null,
      creditNoteUuid: null,
      originalInvoiceNumber: 'QC-2026-00001',
      qiftCreditNoteNumber: note.qiftCreditNoteNumber,
      netComponent: 50,
      reasonCode: 'billing_error',
      taxRuleVersion: 'sa-vat-agent-v3',
      buyerSnapshot: w.invoice.buyerSnapshot,
      issuerSnapshot: w.invoice.sellerSnapshot,
      storeId: null,
      orgId: 'org-nahdi',
      campaignId: 'camp-eid',
      currency: 'SAR',
      amount: 57.5,
      vatComponent: 7.5,
      reason: 'one recipient bucket cancelled before dispatch',
      issuedAt: NOW,
      issuedBy: 'fin-1',
      statementSettlementId: null,
    } as CreditNoteFacts;
    expect(w.noteVersions[0].canonicalJson).toBe(creditNoteCanonical(facts));
    expect(w.noteVersions[0].documentHash).toBe(creditNoteHash(facts));
    const replay = await w.service.replayCreditNote(
      'fin-1',
      note.refundId as string,
    );
    expect(replay.identical).toBe(true);
  });

  it('NO PII: documents, ledger metadata, and audit rows carry business identity only', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const everything = JSON.stringify([
      w.creditNotes,
      w.ledgerRows,
      w.auditRows,
      w.noteVersions,
    ]);
    for (const banned of [
      'recipientName',
      'channelValue',
      'phone',
      'line1',
      'district',
      'tokenHash',
      'sessionToken',
    ]) {
      expect(everything).not.toContain(banned);
    }
  });
});

describe('SETTLE-3c-1 — the 12-step legal walkthrough', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('business event → invoice → payment → refund → QD note → canonical/hash → ledger → compensations → after → audit → replay → references', async () => {
    // 1 Business event: Nahdi's Eid campaign shrank one bucket after
    //   invoicing — Qift refunds a third of its service fee.
    // 2 Original Qift invoice: QC-2026-00001, 172.50 (150 + 22.50 VAT),
    //   frozen tax rule sa-vat-agent-v3, party snapshots frozen.
    const w = world();
    // 3 Payment state: PAID (172.50 received; revenue 150 recognized).
    w.ledgerRows.push({
      eventType: 'qift.revenue.recognized',
      amount: 150,
      direction: 'credit',
      idempotencyKey: 'qift.revenue.recognized:cinv-1',
    });
    const revenuePosition = () =>
      w.ledgerRows
        .filter(
          (r) => r.eventType === 'qift.revenue.recognized' && r.direction === 'credit',
        )
        .reduce((t, r) => t + (r.amount as number), 0) -
      w.ledgerRows
        .filter(
          (r) => r.eventType === 'qift.revenue.recognized' && r.direction === 'debit',
        )
        .reduce((t, r) => t + (r.amount as number), 0);
    expect(revenuePosition()).toBe(150); // ledger BEFORE

    // 4 Refund request: 57.50, billing_error, bank evidence.
    const res = await w.service.recordRefund('fin-1', INPUT() as never);
    expect(res.replayed).toBe(false);

    // 5 Qift Credit Note: QIFT-issued, QD series, QN operational.
    const note = w.creditNotes[0];
    expect(note).toMatchObject({
      issuerType: 'QIFT',
      issuanceSource: 'QIFT',
      noteType: 'qift_service_fee',
      qiftCreditNoteNumber: 'QD-2026-00001',
      amount: 57.5,
      vatComponent: 7.5,
      netComponent: 50,
    });

    // 6 Canonical JSON / hash: stored, hash from the canonical bytes.
    expect(typeof note.canonicalJson).toBe('string');
    expect(w.noteVersions[0].documentHash).toBe(note.documentHash);

    // 7+8 Compensating entries (never edits): cash out of operating,
    //   revenue reversal, VAT reversal — all occurrence-keyed.
    expect(
      w.ledgerRows.map((r) => r.idempotencyKey).filter(Boolean),
    ).toEqual([
      'qift.revenue.recognized:cinv-1',
      `refund.paid:${w.refunds[0].id}`,
      `qift.revenue.recognized:cinv-1:reversal:${w.refunds[0].id}`,
      `refund.approved:${w.refunds[0].id}:vat`,
    ]);

    // 9 Qift revenue/VAT after: 150 − 50 = 100 net recognized.
    expect(revenuePosition()).toBe(100);

    // 10 Audit: issuance + refund records, org-targeted, no PII.
    expect(w.auditRows.map((a) => a.action)).toEqual([
      'finance.credit_note.issued',
      'finance.refund.recorded',
    ]);

    // 11 Replay proof: the document reproduces byte-for-byte.
    const replay = await w.service.replayCreditNote(
      'fin-1',
      note.refundId as string,
    );
    expect(replay).toMatchObject({
      identical: true,
      canonicalIdentical: true,
      hashIdentical: true,
    });

    // 12 References: three identities, never conflated.
    expect(note.referenceNumber).toMatch(/^QN-/); // operational
    expect(note.qiftCreditNoteNumber).toMatch(/^QD-2026-\d{5}$/); // legal
    expect(note.originalInvoiceNumber).toMatch(/^QC-2026-\d{5}$/); // original
  });
});
