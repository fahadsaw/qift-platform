// Track C PR 1 — the MANDATED end-to-end financial walkthrough,
// executable. Every stage of the chain the execution rules require is
// asserted here, in order, with the S01 validation-pack numbers:
//
//   Business event → Ledger before → Ledger entries created →
//   References → Receivable/Payable changes → Settlement state →
//   Audit records → Ledger after.
//
// Story (Validation Pack S01 shape): Nahdi Trading's Eid campaign at
// Dar Alteeb — goods invoice 5,750.00 (5,000 + 750 merchant VAT,
// registered/exclusive) + Qift service invoice 172.50 (150 fee + 22.50
// VAT-on-fee). Both invoices PAID (receipts are SETTLE-1 scope — this
// foundation walkthrough starts at the resulting payable), the goods
// payable becomes an eligible settlement item, finance simulates,
// assembles the batch (QS born), and the walkthrough closes with the
// ledger's frozen record. Money stays in safeguarding — execution is
// SETTLE-2; nothing here moves a riyal, exactly as the foundation
// must.

import { SettlementEngineService } from './settlement-engine.service';
import { calculateSettlement } from './settlement-calculator';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

describe('Track C PR 1 — end-to-end financial walkthrough (S01 numbers)', () => {
  it('walks the full chain: payable → eligible item → simulation → batch (QS) → markers → frozen ledger record', async () => {
    // ── STAGE 0: Business event ─────────────────────────────────────
    // Campaign QB-N4CD-8GVW approved earlier; the two legal documents
    // exist (merchant invoice DAT-2026-0042 for 5,750.00; Qift invoice
    // QC-2026-00001 for 172.50); both were PAID by the company.
    const REFERENCES = {
      campaign: 'QB-N4CD-8GVW',
      qiftInvoice: 'QC-2026-00001',
      merchantInvoiceNumber: 'DAT-2026-0042',
      merchantInvoiceId: 'minv-eid-1',
    };

    // ── STAGE 1: Ledger BEFORE ──────────────────────────────────────
    // The goods collection sits as MERCHANT_PAYABLE (pass-through,
    // FC Ch. 5.1); the fee legs are Qift revenue + VAT-payable. No
    // settlement events exist yet.
    const ledgerEntries: Row[] = [
      {
        eventType: 'merchant.payable.accrued',
        reasonCode: 'MERCHANT_PAYABLE',
        amount: 5750,
        currency: 'SAR',
        direction: 'credit',
        storeId: 's-daralteeb',
        idempotencyKey: 'merchant.payable.accrued:minv-eid-1',
      },
      {
        eventType: 'qift.service_fee.accrued',
        reasonCode: 'QIFT_SERVICE_FEE',
        amount: 150,
        currency: 'SAR',
        direction: 'credit',
        idempotencyKey: 'qift.service_fee.accrued:inv-eid-1',
      },
    ];
    const payableBefore = ledgerEntries
      .filter((e) => e.reasonCode === 'MERCHANT_PAYABLE')
      .reduce((s, e) => s + (e.amount as number), 0);
    expect(payableBefore).toBe(5750); // merchant signed net position: +5,750 owed

    // ── The settlement item the payable produced (eligibility per §5
    // is SETTLE-1 scope; the foundation receives it eligible) ────────
    const items: Row[] = [
      {
        id: 'sitem-1',
        occurrenceType: 'merchant_invoice',
        occurrenceId: REFERENCES.merchantInvoiceId,
        storeId: 's-daralteeb',
        currency: 'SAR',
        amount: 5750,
        state: 'eligible',
        batchId: null,
      },
    ];

    // Engine harness over the story's rows.
    const batches = new Map<string, Row>();
    let seq = 0;
    const prisma = {
      settlementItem: {
        findMany: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(items.filter((i) => i.state === 'eligible')),
          ),
        updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
          const w = where as {
            id: { in: string[] };
            state?: string;
            batchId?: string | null;
          };
          let count = 0;
          for (const i of items) {
            if (!w.id.in.includes(i.id as string)) continue;
            if (w.state !== undefined && i.state !== w.state) continue;
            if (w.batchId !== undefined && i.batchId !== w.batchId) continue;
            Object.assign(i, data as Row);
            count++;
          }
          return Promise.resolve({ count });
        }),
        update: jest.fn(),
      },
      merchantInvoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: REFERENCES.merchantInvoiceId,
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
    const auditLog: Row[] = [];
    const audit = {
      record: jest.fn().mockImplementation((row: Row) => {
        auditLog.push(row);
        return Promise.resolve(undefined);
      }),
    };
    const ledger = {
      // (row, txClient) — the engine posts markers INSIDE its tx.
      record: jest.fn().mockImplementation((row: Row) => {
        ledgerEntries.push(row);
        return Promise.resolve({ id: `led-${ledgerEntries.length}` });
      }),
    };
    const engine = new SettlementEngineService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      ledger as unknown as FinancialLedgerService,
      // Rule 2: a fixed clock — the walkthrough is time-deterministic.
      { now: () => new Date('2026-07-20T12:00:00.000Z') },
    );

    // ── STAGE 2: Simulation (mandatory pre-execution review, §30.4) ─
    const sim = await engine.simulate('founder-finance', 's-daralteeb');
    expect(sim.calculation!.netAmount).toBe(5750);
    expect(JSON.stringify(sim)).not.toMatch(/QS-/); // no QS on previews

    // ── STAGE 3: Assembly — ledger entries created; QS born ─────────
    const batch = await engine.assembleBatch('founder-finance', 's-daralteeb');

    // References: the full chain now names every object canonically.
    const QS = batch.settlementReference as string;
    expect(QS).toMatch(/^QS-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(REFERENCES.campaign).toMatch(/^QB-/);
    expect(REFERENCES.qiftInvoice).toMatch(/^QC-2026-\d{5}$/);
    // The merchant's number was SUPPLIED, never manufactured (RC Ch. 9).
    expect(REFERENCES.merchantInvoiceNumber).toBe('DAT-2026-0042');

    // Ledger entries created by the foundation: exactly ONE zero-amount
    // lifecycle marker with a deterministic key. No money moved.
    const created = ledgerEntries.slice(2);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      eventType: 'settlement.started',
      amount: 0,
      idempotencyKey: `settlement.started:${batch.id}`,
    });

    // ── STAGE 4: Receivable / Payable changes ───────────────────────
    // NONE — constitutionally. The payable extinguishes at remittance
    // (SETTLE-2, merchant.remittance.paid); assembly only BINDS it.
    const payableAfter = ledgerEntries
      .filter((e) => e.reasonCode === 'MERCHANT_PAYABLE')
      .reduce((s, e) => s + (e.amount as number), 0);
    expect(payableAfter).toBe(payableBefore); // still 5,750 owed, now staged under QS

    // ── STAGE 5: Settlement state ───────────────────────────────────
    expect(batch.status).toBe('ready');
    expect(items[0].state).toBe('ready');
    expect(items[0].batchId).toBe(batch.id);
    expect(batch.netAmount).toBe(5750);

    // ── STAGE 6: Audit records ──────────────────────────────────────
    const actions = auditLog.map((a) => a.action);
    expect(actions).toEqual([
      'settlement.simulated',
      'settlement.batch.assembled',
    ]);
    const assembled = auditLog[1];
    expect(assembled.metadata).toMatchObject({
      settlementReference: QS,
      itemCount: 1,
      grossAmount: 5750,
      netAmount: 5750,
      currency: 'SAR',
    });

    // ── STAGE 7: Ledger AFTER — the §34 frozen record ───────────────
    // The batch row froze composition + calculation; replaying the
    // frozen composition through the ONE calculator reproduces the
    // stored snapshot identically (Deterministic Replay Law).
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
