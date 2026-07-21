// Track C PR 2 — the MANDATED end-to-end financial walkthrough,
// executable. SETTLE-1 extends the S01 chain BACKWARD to the business
// event (both invoices paid by the company) and proves SC §25.1 up to
// batch assembly:
//
//   Business event → Ledger before → Ledger entries created →
//   References → Receivable/Payable changes → Settlement state →
//   Audit records → Ledger after (+ §34 replay).
//
// Story (Validation Pack S01): Nahdi Trading's Eid campaign at Dar
// Alteeb. Goods invoice DAT-2026-0042 = 5,750.00 (merchant's legal
// document); Qift service invoice QC-2026-00001 = 172.50 (150 fee +
// 22.50 VAT-on-fee, VAT posted at ISSUANCE). Nahdi pays the goods
// invoice in TWO bank transfers (2,000 then 3,750 — partial payments
// are lawful) and the fee invoice in one. Finance records the
// receipts, the §5 evaluator promotes the item, and the engine
// assembles the batch (QS born). Execution is SETTLE-2 — nothing
// here moves a riyal OUT; the payable ends exactly where it started:
// 5,750.00 held for the merchant under a QS.

import { SettlementReceiptsService } from './settlement-receipts.service';
import { SettlementEligibilityService } from './settlement-eligibility.service';
import { SettlementEngineService } from './settlement-engine.service';
import { calculateSettlement } from './settlement-calculator';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';

describe('Track C PR 2 — end-to-end financial walkthrough (S01, receipts → eligibility → batch)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('walks the full chain: invoices issued → receipts → payable → item pending → eligible → batch (QS) → frozen ledger record', async () => {
    // ── STAGE 0: Business event ─────────────────────────────────────
    // Campaign QB-N4CD-8GVW approved; both legal documents issued and
    // their ISSUANCE postings already on the ledger (Track B law:
    // receivable at issuance, VAT at issuance — FC 7.6 tax point).
    const REFERENCES = {
      campaign: 'QB-N4CD-8GVW',
      qiftInvoice: 'QC-2026-00001',
      merchantInvoiceNumber: 'DAT-2026-0042',
    };
    const ledgerRows: Row[] = [
      {
        eventType: 'corporate.invoice.issued',
        reasonCode: 'CORPORATE_RECEIVABLE',
        amount: 172.5,
        currency: 'SAR',
        direction: 'credit',
        idempotencyKey: 'corporate.invoice.issued:cinv-1',
      },
      {
        eventType: 'merchant.invoice.issued',
        reasonCode: 'MERCHANT_GOODS_INVOICED',
        amount: 5750,
        currency: 'SAR',
        direction: 'credit',
        idempotencyKey: 'merchant.invoice.issued:minv-1',
      },
    ];

    // ── Shared in-memory world ──────────────────────────────────────
    let seq = 0;
    const receipts: Row[] = [];
    const sItems: Row[] = [];
    const batches = new Map<string, Row>();
    const auditRows: Row[] = [];
    const corpInvoice: Row = {
      id: 'cinv-1',
      status: 'issued',
      totalAmount: 172.5,
      platformFeeAmount: 150,
      currency: 'SAR',
      orgId: 'org-nahdi',
      campaignId: 'camp-eid',
      invoiceNumber: REFERENCES.qiftInvoice,
    };
    const merchInvoice: Row = {
      id: 'minv-1',
      status: 'issued',
      totalAmount: 5750,
      currency: 'SAR',
      orgId: 'org-nahdi',
      campaignId: 'camp-eid',
      storeId: 's-daralteeb',
      merchantInvoiceNumber: REFERENCES.merchantInvoiceNumber,
    };
    const store: Row = {
      id: 's-daralteeb',
      payoutIdentityVerifiedAt: null as Date | null,
      payoutIdentityEvidence: null as string | null,
    };
    // Every recipient claimed their gift; the claim window settled.
    const claims: Row[] = [
      { status: 'claimed', expiresAt: new Date('2026-07-10T00:00:00.000Z') },
      { status: 'claimed', expiresAt: new Date('2026-07-10T00:00:00.000Z') },
      { status: 'expired', expiresAt: new Date('2026-07-10T00:00:00.000Z') },
    ];

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
        findUnique: jest.fn(),
        findMany: jest.fn().mockImplementation(({ where }: never) => {
          const w = where as Row;
          return Promise.resolve(
            receipts
              .filter(
                (r) =>
                  r.invoiceType === w.invoiceType &&
                  r.invoiceId === w.invoiceId,
              )
              .sort(
                (a, b) =>
                  (a.receivedAt as Date).getTime() -
                  (b.receivedAt as Date).getTime(),
              ),
          );
        }),
      },
      corporateInvoice: {
        findUnique: jest.fn().mockResolvedValue(corpInvoice),
        updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
          const w = where as Row;
          if (corpInvoice.status !== w.status)
            return Promise.resolve({ count: 0 });
          Object.assign(corpInvoice, data as Row);
          return Promise.resolve({ count: 1 });
        }),
      },
      merchantInvoice: {
        findMany: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve([
              {
                id: merchInvoice.id,
                merchantInvoiceNumber: merchInvoice.merchantInvoiceNumber,
                campaignId: merchInvoice.campaignId,
              },
            ]),
          ),
        findUnique: jest.fn().mockResolvedValue(merchInvoice),
        updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
          const w = where as Row;
          if (merchInvoice.status !== w.status)
            return Promise.resolve({ count: 0 });
          Object.assign(merchInvoice, data as Row);
          return Promise.resolve({ count: 1 });
        }),
      },
      settlementItem: {
        create: jest.fn().mockImplementation(({ data }: never) => {
          // Model Prisma's column defaults: nullable columns are NULL.
          const row = {
            id: `sitem-${++seq}`,
            batchId: null,
            holdType: null,
            holdEvidence: null,
            createdAt: new Date('2026-07-20T15:00:00.000Z'),
            ...(data as Row),
          };
          sItems.push(row);
          return Promise.resolve(row);
        }),
        findMany: jest.fn().mockImplementation(({ where }: never) => {
          const w = where as Row;
          return Promise.resolve(
            sItems.filter(
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
            state?: string;
            batchId?: string | null;
          };
          const ids =
            w.id === undefined
              ? null
              : typeof w.id === 'string'
                ? [w.id]
                : w.id.in;
          let count = 0;
          for (const i of sItems) {
            if (ids && !ids.includes(i.id as string)) continue;
            if (w.state !== undefined && i.state !== w.state) continue;
            if (w.batchId !== undefined && i.batchId !== w.batchId) continue;
            Object.assign(i, data as Row);
            count++;
          }
          return Promise.resolve({ count });
        }),
      },
      store: {
        findUnique: jest.fn().mockResolvedValue(store),
        update: jest.fn().mockImplementation(({ data }: never) => {
          Object.assign(store, data as Row);
          return Promise.resolve(store);
        }),
      },
      claimableGift: {
        findMany: jest.fn().mockResolvedValue(claims),
      },
      giftCampaign: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'camp-eid', referenceNumber: REFERENCES.campaign },
          ]),
      },
      settlementBatch: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: never) => {
          const row = { id: `stl-${++seq}`, ...(data as Row) };
          batches.set(row.id as string, row);
          return Promise.resolve(row);
        }),
        update: jest.fn(),
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
    const clock = { now: () => new Date('2026-07-21T09:00:00.000Z') };
    const receiptsSvc = new SettlementReceiptsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      ledger as unknown as FinancialLedgerService,
      clock,
    );
    const eligibilitySvc = new SettlementEligibilityService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      clock,
    );
    const engine = new SettlementEngineService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      ledger as unknown as FinancialLedgerService,
      clock,
    );

    // ── STAGE 1: Ledger BEFORE ──────────────────────────────────────
    // Issuance postings only. NO cash, NO payable yet (accruals never
    // settle — §5.1). Signed payable position: 0.00.
    const payable = () =>
      ledgerRows
        .filter((e) => e.eventType === 'merchant.payable.accrued')
        .reduce((s, e) => s + (e.amount as number), 0);
    expect(payable()).toBe(0);
    expect(ledgerRows).toHaveLength(2);

    // ── STAGE 2: Ledger entries created — receipts land ─────────────
    // Nahdi pays the GOODS invoice in two transfers (partials lawful).
    const r1 = await receiptsSvc.recordReceipt('founder-finance', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 2000,
      bankReference: 'BANK-TT-9001',
      receivedAt: '2026-07-19T10:00:00.000Z',
    });
    expect(r1.coverage!.covered).toBe(false);
    expect(merchInvoice.status).toBe('issued'); // partial ≠ paid
    const r2 = await receiptsSvc.recordReceipt('founder-finance', {
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      amount: 3750,
      bankReference: 'BANK-TT-9002',
      receivedAt: '2026-07-20T14:30:00.000Z',
    });
    expect(r2.coverage!.covered).toBe(true);
    // ...and the FEE invoice in one.
    await receiptsSvc.recordReceipt('founder-finance', {
      invoiceType: 'corporate_invoice',
      invoiceId: 'cinv-1',
      amount: 172.5,
      bankReference: 'BANK-TT-9003',
      receivedAt: '2026-07-20T15:00:00.000Z',
    });

    // paid DERIVED from coverage; paidAt = completing VALUE dates.
    expect(merchInvoice.status).toBe('paid');
    expect((merchInvoice.paidAt as Date).toISOString()).toBe(
      '2026-07-20T14:30:00.000Z',
    );
    expect(corpInvoice.status).toBe('paid');

    // The receipt posting groups, occurrence-anchored:
    //   goods: 2 × (payment.received credit + payable.accrued debit)
    //   fee:   1 × payment.received credit + revenue.recognized:{cinv}
    const paymentEvents = ledgerRows.filter(
      (e) => e.eventType === 'invoice.payment.received',
    );
    expect(paymentEvents).toHaveLength(3);
    expect(
      paymentEvents.map((e) => (e.metadata as Row).account),
    ).toEqual(['safeguarding', 'safeguarding', 'operating']); // §13.3
    const revenue = ledgerRows.filter(
      (e) => e.eventType === 'qift.revenue.recognized',
    );
    expect(revenue).toHaveLength(1);
    expect(revenue[0]).toMatchObject({
      amount: 150,
      idempotencyKey: 'qift.revenue.recognized:cinv-1',
    });

    // ── STAGE 3: Receivable / Payable changes ───────────────────────
    // MERCHANT_PAYABLE converted PER RECEIPT as cash landed: 5,750.00.
    expect(payable()).toBe(5750);

    // ── STAGE 4: Settlement state — pending → eligible (§5) ─────────
    expect(sItems).toHaveLength(1);
    expect(sItems[0].state).toBe('pending');
    // First evaluation: payout identity NOT yet verified → blocked.
    const blocked = await eligibilitySvc.evaluate(
      'founder-finance',
      's-daralteeb',
    );
    expect(blocked.eligibleCount).toBe(0);
    // Ops verifies the merchant's payout identity (§5.4), evidenced.
    await eligibilitySvc.verifyPayoutIdentity(
      'founder-finance',
      's-daralteeb',
      'IBAN letter sighted + CR match (ops ticket OPS-291)',
    );
    const evaluated = await eligibilitySvc.evaluate(
      'founder-finance',
      's-daralteeb',
    );
    expect(evaluated.eligibleCount).toBe(1);
    expect(sItems[0].state).toBe('eligible');

    // ── STAGE 5: Batch assembly — QS born (§14.1) ───────────────────
    const batch = await engine.assembleBatch('founder-finance', 's-daralteeb');
    const QS = batch.settlementReference as string;
    expect(QS).toMatch(/^QS-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(sItems[0].state).toBe('ready');
    expect(sItems[0].batchId).toBe(batch.id);
    expect(batch.netAmount).toBe(5750);
    // Exactly ONE zero-amount started marker, deterministic key.
    const markers = ledgerRows.filter(
      (e) => e.eventType === 'settlement.started',
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      amount: 0,
      idempotencyKey: `settlement.started:${batch.id}`,
    });

    // ── STAGE 6: References — the chain names every object ──────────
    expect(REFERENCES.campaign).toMatch(/^QB-/);
    expect(REFERENCES.qiftInvoice).toMatch(/^QC-2026-\d{5}$/);
    expect(REFERENCES.merchantInvoiceNumber).toBe('DAT-2026-0042'); // SUPPLIED, never manufactured
    expect(receipts.map((r) => r.bankReference)).toEqual([
      'BANK-TT-9001',
      'BANK-TT-9002',
      'BANK-TT-9003',
    ]);

    // ── STAGE 7: Audit records — the full decision trail ────────────
    expect(auditRows.map((a) => a.action)).toEqual([
      'finance.receipt.recorded',
      'finance.receipt.recorded',
      'finance.invoice.paid',
      'settlement.item.created',
      'finance.receipt.recorded',
      'finance.invoice.paid',
      'settlement.item.still_pending',
      'settlement.payout_identity.verified',
      'settlement.item.eligible',
      'settlement.batch.assembled',
    ]);

    // ── STAGE 8: Ledger AFTER + §34 replay ──────────────────────────
    // Assembly moved NO money: the payable still stands at 5,750.00,
    // now bound under the QS awaiting SETTLE-2 execution.
    expect(payable()).toBe(5750);
    const frozen = batches.get(batch.id as string)!;
    const replayed = calculateSettlement(
      (
        frozen.composition as Array<{
          itemId: string;
          occurrenceType: string;
          occurrenceId: string;
          amount: number;
          currency: string;
        }>
      ).map((c) => ({ ...c })),
    );
    expect(replayed).toEqual(frozen.calculationSnapshot);
    expect(replayed.netAmount).toBe(5750);
  });
});
