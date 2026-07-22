// Refund-integrity PR (Track C corrective) — BOUNDARY 3: refund
// maker–checker + execution separation, and BOUNDARY 1: credit-note
// issuance vs cash evidence. Money can leave only through
// request → INDEPENDENT approval → evidenced execution; the approval
// binds an immutable canonical snapshot; the final approver never
// executes; duplicate bank evidence never pays twice.
//
// Thresholds: RESERVED — the §32 authorization matrix carries no
// refund row; introducing refund thresholds requires a Settlement
// Constitution amendment, not code.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ConflictException } from '@nestjs/common';
import { SettlementRefundsService } from './settlement-refunds.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const NOW = '2026-07-23T12:00:00.000Z';

// Same world discipline as the fee-refunds spec (frozen invoice, no
// engines), extended with the RefundRequest lifecycle store. Mock
// models DB reality: null column defaults, copy-on-read, updateMany
// honoring EVERY where field (the guarded-transition contract).
function world() {
  let seq = 0;
  let seriesValue = 0;
  const invoice: Row = {
    id: 'cinv-1',
    invoiceNumber: 'QC-2026-00001',
    status: 'paid',
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
  // Goods-leg invoice for the legal-number completion-lane tests —
  // merchantInvoiceNumber starts NULL (lawfully attachable later).
  const merchantInv: Row = {
    id: 'minv-1',
    merchantInvoiceNumber: null,
    status: 'paid',
    totalAmount: 5750,
    vatAmount: 750,
    currency: 'SAR',
    orgId: 'org-nahdi',
    campaignId: 'camp-eid',
    storeId: 's-1',
  };
  const requests: Row[] = [];
  const refunds: Row[] = [];
  const creditNotes: Row[] = [];
  const noteVersions: Row[] = [];
  const ledgerRows: Row[] = [];
  const auditRows: Row[] = [];
  const prisma = {
    corporateInvoice: { findUnique: jest.fn().mockResolvedValue(invoice) },
    merchantInvoice: {
      findUnique: jest.fn().mockImplementation(() =>
        Promise.resolve(merchantInv ? { ...merchantInv } : null),
      ),
    },
    paymentReceipt: {
      findMany: jest.fn().mockResolvedValue([{ amount: 172.5 }]),
    },
    refundRequest: {
      create: jest.fn().mockImplementation(({ data }: never) => {
        const row: Row = {
          id: `rr-${++seq}`,
          storeId: null,
          reasonCode: null,
          approvedBy: null,
          approvedAt: null,
          executedBy: null,
          executedAt: null,
          cancelledBy: null,
          cancelledAt: null,
          refundId: null,
          createdAt: new Date(NOW),
          ...(data as Row),
        };
        requests.push(row);
        return Promise.resolve({ ...row });
      }),
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = where as { id?: string; refundId?: string };
        const found = requests.find(
          (r) =>
            (w.id !== undefined && r.id === w.id) ||
            (w.refundId !== undefined &&
              r.refundId !== null &&
              r.refundId === w.refundId),
        );
        return Promise.resolve(found ? { ...found } : null);
      }),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where ?? {}) as { state?: string };
        return Promise.resolve(
          requests
            .filter((r) => w.state === undefined || r.state === w.state)
            .map((r) => ({ ...r })),
        );
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: never) => {
        const w = where as { id: string; state: string };
        const hits = requests.filter(
          (r) => r.id === w.id && r.state === w.state,
        );
        for (const r of hits) Object.assign(r, data as Row);
        return Promise.resolve({ count: hits.length });
      }),
    },
    settlementRefund: {
      findUnique: jest.fn().mockImplementation(({ where }: never) => {
        const w = (where as Row).invoiceType_invoiceId_evidenceRef as Row;
        const found = refunds.find(
          (r) =>
            r.invoiceType === w.invoiceType &&
            r.invoiceId === w.invoiceId &&
            r.evidenceRef === w.evidenceRef,
        );
        return Promise.resolve(found ? { ...found } : null);
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
    // Agent-model tripwires — these exist to prove the workflow NEVER
    // touches merchant money.
    settlementItem: { findUnique: jest.fn(), updateMany: jest.fn() },
    settlementReceivable: { create: jest.fn(), findMany: jest.fn() },
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
    merchantInv,
    requests,
    refunds,
    creditNotes,
    noteVersions,
    ledgerRows,
    auditRows,
  };
}

const REQ = (over: Row = {}) => ({
  invoiceType: 'corporate_invoice' as const,
  invoiceId: 'cinv-1',
  amount: 57.5,
  reason: 'one recipient bucket cancelled before dispatch',
  reasonCode: 'billing_error',
  ...over,
});

const EVIDENCE = (over: Row = {}) => ({
  evidenceRef: 'BANK-REF-OUT-7001',
  refundedAt: '2026-07-23T10:00:00.000Z',
  confirmedAmount: 57.5,
  ...over,
});

const MAKER = 'fin-maker';
const CHECKER = 'fin-checker';
const EXECUTOR = 'fin-executor';

describe('Refund maker–checker (boundary 3) + evidence law (boundary 1)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('WALKTHROUGH: request → independent approval → evidenced execution — three identities, snapshot-bound, cash posted exactly once', async () => {
    const w = world();

    // 1 — MAKER files the request. An immutable canonical snapshot is
    //     hashed over invoice + amount + VAT + reason + recipient +
    //     method, quoting the FROZEN invoice's legal number.
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    expect(req.state).toBe('requested');
    expect(req.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(req.requestedBy).toBe(MAKER);

    // 2 — Requesting and approving move NO money and issue NO
    //     documents: a credit note without evidence would be boundary
    //     1's exact violation.
    expect(w.ledgerRows).toHaveLength(0);
    expect(w.creditNotes).toHaveLength(0);
    expect(w.refunds).toHaveLength(0);

    // 3 — CHECKER (≠ maker) approves against the intact snapshot.
    const approved = await w.service.approveRefund(CHECKER, req.id as string);
    expect(approved.state).toBe('approved');
    expect(approved.approvedBy).toBe(CHECKER);
    expect(w.ledgerRows).toHaveLength(0); // still no money

    // 4 — EXECUTOR (≠ final approver) executes with external evidence:
    //     bank reference, value date, bank-confirmed amount.
    const done = await w.service.executeRefund(
      EXECUTOR,
      req.id as string,
      EVIDENCE() as never,
    );
    expect(done.request.state).toBe('executed');
    expect(done.request.executedBy).toBe(EXECUTOR);
    expect(done.request.refundId).toBe(done.refund.id);
    expect(done.replayed).toBe(false);

    // 5 — The refund row carries the evidence; the credit note and
    //     postings exist exactly once, inside the tx.
    expect(w.refunds).toHaveLength(1);
    expect(w.refunds[0].evidenceRef).toBe('BANK-REF-OUT-7001');
    expect(w.creditNotes).toHaveLength(1);
    const paid = w.ledgerRows.find((r) => r.eventType === 'refund.paid');
    expect(paid).toBeTruthy();
    expect(paid!.insideTx).toBe(true);

    // 6 — The audit trail names all three identities on the terminal
    //     record — the separation is reconstructable forever.
    const executedAudit = w.auditRows.find(
      (a) => a.action === 'finance.refund.executed',
    )!;
    const meta = executedAudit.metadata as Row;
    expect(meta.requestedBy).toBe(MAKER);
    expect(meta.approvedBy).toBe(CHECKER);
    expect(meta.executedBy).toBe(EXECUTOR);
    expect(
      w.auditRows.map((a) => a.action),
    ).toEqual([
      'finance.refund.requested',
      'finance.refund.approved',
      'finance.credit_note.issued',
      'finance.refund.recorded',
      'finance.refund.executed',
    ]);
  });

  it('SELF-APPROVAL is rejected: the requester can never be the approver', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await expect(
      w.service.approveRefund(MAKER, req.id as string),
    ).rejects.toThrow('refund_self_approval_rejected');
    expect(w.requests[0].state).toBe('requested'); // unchanged
    expect(w.ledgerRows).toHaveLength(0);
  });

  it('FINAL APPROVER cannot execute: approval and execution are separate hands', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    await expect(
      w.service.executeRefund(CHECKER, req.id as string, EVIDENCE() as never),
    ).rejects.toThrow('refund_approver_cannot_execute');
    expect(w.requests[0].state).toBe('approved'); // no state burn
    expect(w.ledgerRows).toHaveLength(0);
    expect(w.refunds).toHaveLength(0);
    // The REQUESTER may execute (preparer-execution, §33.2 shape) —
    // the mandated separation is approver ≠ executor.
    const done = await w.service.executeRefund(
      MAKER,
      req.id as string,
      EVIDENCE() as never,
    );
    expect(done.request.state).toBe('executed');
  });

  it('CHANGED AMOUNT after approval is rejected: snapshot-hash drift voids the request', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    // Simulate row tamper between approval and execution (the attack
    // the canonical snapshot exists to kill).
    w.requests[0].amount = 90;
    await expect(
      w.service.executeRefund(
        EXECUTOR,
        req.id as string,
        EVIDENCE({ confirmedAmount: 90 }) as never,
      ),
    ).rejects.toThrow('refund_snapshot_tampered');
    expect(w.ledgerRows).toHaveLength(0);
    expect(w.refunds).toHaveLength(0);
  });

  it('BANK-CONFIRMED amount must equal the approved snapshot amount exactly', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    await expect(
      w.service.executeRefund(
        EXECUTOR,
        req.id as string,
        EVIDENCE({ confirmedAmount: 57.49 }) as never,
      ),
    ).rejects.toThrow('refund_confirmed_amount_mismatch');
    expect(w.ledgerRows).toHaveLength(0);
  });

  it('DUPLICATE EVIDENCE is rejected: the same bank transfer can never satisfy two requests', async () => {
    const w = world();
    const r1 = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, r1.id as string);
    await w.service.executeRefund(EXECUTOR, r1.id as string, EVIDENCE() as never);

    // Same evidence + DIFFERENT amount: the §18.1 replay-consistency
    // guard refuses before the ownership check even runs.
    const r2 = await w.service.requestRefund(MAKER, REQ({ amount: 30 }) as never);
    await w.service.approveRefund(CHECKER, r2.id as string);
    await expect(
      w.service.executeRefund(
        EXECUTOR,
        r2.id as string,
        EVIDENCE({ confirmedAmount: 30 }) as never, // SAME evidenceRef
      ),
    ).rejects.toThrow('refund_evidence_conflict');
    // Same evidence + SAME amount: replay-by-identity succeeds
    // underneath, but the refund already belongs to r1 — refused.
    const r3 = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, r3.id as string);
    await expect(
      w.service.executeRefund(
        EXECUTOR,
        r3.id as string,
        EVIDENCE() as never,
      ),
    ).rejects.toThrow('refund_evidence_already_used');
    // Exactly one refund, one credit note, one paid posting.
    expect(w.refunds).toHaveLength(1);
    expect(w.creditNotes).toHaveLength(1);
    expect(
      w.ledgerRows.filter((r) => r.eventType === 'refund.paid'),
    ).toHaveLength(1);
    expect(w.requests[1].state).toBe('approved'); // r2 never executed
    expect(w.requests[2].state).toBe('approved'); // r3 never executed
  });

  it('RETRY SAFETY: a crash between cash posting and finalize leaves the EXECUTING latch — cancel-blocked, resumable only by the same executor, money posts once', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    // Crash AFTER recordRefund, BEFORE the finalize bind: only the
    // updateMany that writes state='executed' fails (the latch is
    // claim-first and has already succeeded).
    const um = w.prisma.refundRequest.updateMany as jest.Mock;
    const real = um.getMockImplementation()!;
    let crashFinalize = true;
    um.mockImplementation((args: { data?: { state?: string } }) => {
      if (crashFinalize && args.data?.state === 'executed') {
        crashFinalize = false;
        return Promise.reject(new Error('connection lost'));
      }
      return real(args as never);
    });
    await expect(
      w.service.executeRefund(EXECUTOR, req.id as string, EVIDENCE() as never),
    ).rejects.toThrow('connection lost');
    expect(w.refunds).toHaveLength(1); // money already posted
    expect(w.requests[0].state).toBe('executing'); // latch held

    // The latch BLOCKS cancel — cash has moved; the record can no
    // longer be walked back to "never happened".
    await expect(
      w.service.cancelRefundRequest(MAKER, req.id as string),
    ).rejects.toThrow('refund_request_not_cancellable:executing');

    // A DIFFERENT executor cannot steal the latch.
    await expect(
      w.service.executeRefund(MAKER, req.id as string, EVIDENCE() as never),
    ).rejects.toThrow('refund_request_contended');

    // The SAME executor resumes: §18.1 replay-by-identity returns the
    // existing refund, the orphan is bound, nothing double-posts.
    const done = await w.service.executeRefund(
      EXECUTOR,
      req.id as string,
      EVIDENCE() as never,
    );
    expect(done.replayed).toBe(true);
    expect(done.request.state).toBe('executed');
    expect(done.request.refundId).toBe(w.refunds[0].id);
    expect(w.refunds).toHaveLength(1);
    expect(
      w.ledgerRows.filter((r) => r.eventType === 'refund.paid'),
    ).toHaveLength(1);

    // A further call after completion refuses cleanly on state.
    await expect(
      w.service.executeRefund(EXECUTOR, req.id as string, EVIDENCE() as never),
    ).rejects.toThrow('refund_request_not_approved:executed');
  });

  it('TRANSPORT ERROR in the primitive HOLDS the latch (commit may have landed); a typed refusal unlatches', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    // Transport failure inside the primitive: the commit may have
    // landed server-side, so the row must STAY latched (cancel would
    // otherwise reopen against a possibly-posted refund).
    (w.prisma.paymentReceipt.findMany as jest.Mock).mockRejectedValueOnce(
      new Error('socket hang up'),
    );
    await expect(
      w.service.executeRefund(EXECUTOR, req.id as string, EVIDENCE() as never),
    ).rejects.toThrow('socket hang up');
    expect(w.requests[0].state).toBe('executing'); // latch HELD
    await expect(
      w.service.cancelRefundRequest(MAKER, req.id as string),
    ).rejects.toThrow('refund_request_not_cancellable:executing');
    // The same executor resumes to completion.
    const done = await w.service.executeRefund(
      EXECUTOR,
      req.id as string,
      EVIDENCE() as never,
    );
    expect(done.request.state).toBe('executed');
    expect(
      w.ledgerRows.filter((r) => r.eventType === 'refund.paid'),
    ).toHaveLength(1);

    // Contrast: a TYPED refusal (confirmed-amount mismatch happens
    // pre-latch, so use an over-cap primitive refusal) unlatches.
    const r2 = await w.service.requestRefund(
      MAKER,
      REQ({ amount: 160, reason: 'second, over remaining cap' }) as never,
    );
    await w.service.approveRefund(CHECKER, r2.id as string);
    await expect(
      w.service.executeRefund(
        EXECUTOR,
        r2.id as string,
        EVIDENCE({
          evidenceRef: 'BANK-REF-OUT-7002',
          confirmedAmount: 160,
        }) as never,
      ),
    ).rejects.toThrow('refund_exceeds_invoice');
    expect(w.requests[1].state).toBe('approved'); // unlatched
    expect(w.requests[1].executedBy).toBeNull();
  });

  it('CANCEL RACE is impossible: the latch claims the row BEFORE any cash moves, so cancel-vs-execute has a single winner', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    // Cancel lands between the executor's state read and the latch:
    // the latch (guarded on state='approved') loses — and NO money
    // has moved at refusal time.
    const um = w.prisma.refundRequest.updateMany as jest.Mock;
    const real = um.getMockImplementation()!;
    let injected = false;
    um.mockImplementation(async (args: { data?: { state?: string } }) => {
      if (!injected && args.data?.state === 'executing') {
        injected = true;
        await real({
          where: { id: req.id, state: 'approved' },
          data: { state: 'cancelled', cancelledBy: MAKER },
        } as never);
      }
      return real(args as never);
    });
    await expect(
      w.service.executeRefund(EXECUTOR, req.id as string, EVIDENCE() as never),
    ).rejects.toThrow('refund_request_contended');
    expect(w.refunds).toHaveLength(0); // NOT A RIYAL moved
    expect(w.ledgerRows).toHaveLength(0);
    expect(w.creditNotes).toHaveLength(0);
    expect(w.requests[0].state).toBe('cancelled');
  });

  it('CONCURRENT roll-forward: losing the unique refundId race refuses cleanly and unlatches, never crashes raw', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    // Finalize loses the unique-refundId race: P2002 → typed refusal,
    // and the row unlatches back to 'approved' (not wedged).
    const um = w.prisma.refundRequest.updateMany as jest.Mock;
    const real = um.getMockImplementation()!;
    let fired = false;
    um.mockImplementation((args: { data?: { state?: string } }) => {
      if (!fired && args.data?.state === 'executed') {
        fired = true;
        return Promise.reject(
          Object.assign(new Error('unique'), { code: 'P2002' }),
        );
      }
      return real(args as never);
    });
    await expect(
      w.service.executeRefund(EXECUTOR, req.id as string, EVIDENCE() as never),
    ).rejects.toThrow('refund_evidence_already_used');
    expect(w.requests[0].state).toBe('approved'); // unlatched
    expect(w.requests[0].executedBy).toBeNull();
  });

  it('LEGAL-NUMBER COMPLETION is not tamper: a merchant number arriving after the request (null → value) still verifies', async () => {
    const w = world();
    const req = await w.service.requestRefund(
      MAKER,
      REQ({
        invoiceType: 'merchant_invoice',
        invoiceId: 'minv-1',
        amount: 2000,
        reasonCode: undefined,
      }) as never,
    );
    // The merchant supplies their legal number AFTER the request was
    // filed — routine document completion, immutable once set.
    w.merchantInv.merchantInvoiceNumber = 'DAT-2026-0042';
    const approved = await w.service.approveRefund(CHECKER, req.id as string);
    expect(approved.state).toBe('approved'); // NOT refund_snapshot_tampered
  });

  it('LEGAL-NUMBER TAMPER is still tamper: a number CHANGING after the request (value → different value) refuses', async () => {
    const w = world();
    w.merchantInv.merchantInvoiceNumber = 'DAT-2026-0042'; // set BEFORE
    const req = await w.service.requestRefund(
      MAKER,
      REQ({
        invoiceType: 'merchant_invoice',
        invoiceId: 'minv-1',
        amount: 2000,
        reasonCode: undefined,
      }) as never,
    );
    w.merchantInv.merchantInvoiceNumber = 'DAT-9999-0001'; // mutated
    await expect(
      w.service.approveRefund(CHECKER, req.id as string),
    ).rejects.toThrow('refund_snapshot_tampered');
  });

  it('NO MERCHANT-MONEY impact: the fee-refund workflow never touches items, receivables, reserves, or safeguarding', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    await w.service.approveRefund(CHECKER, req.id as string);
    await w.service.executeRefund(EXECUTOR, req.id as string, EVIDENCE() as never);
    expect(w.prisma.settlementItem.findUnique).not.toHaveBeenCalled();
    expect(w.prisma.settlementItem.updateMany).not.toHaveBeenCalled();
    expect(w.prisma.settlementReceivable.create).not.toHaveBeenCalled();
    expect(w.prisma.settlementReceivable.findMany).not.toHaveBeenCalled();
    expect(w.prisma.merchantInvoice.findUnique).not.toHaveBeenCalled();
    expect(
      w.ledgerRows.every((r) => r.account !== 'safeguarding'),
    ).toBe(true);
    expect(
      w.ledgerRows.every(
        (r) => !(r.eventType as string).startsWith('merchant.'),
      ),
    ).toBe(true);
  });

  it('CENSUS PIN: no controller reaches recordRefund directly — the primitive is workflow-only', () => {
    // Adversarial finding 6: the rules doc declares recordRefund
    // "reachable only via executeRefund". This pin makes the boundary
    // self-enforcing: adding a controller call site fails here and
    // must arrive with its own constitutional justification.
    const srcRoot = join(__dirname, '..');
    const controllers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith('.controller.ts'))
          controllers.push(join(dir, entry.name));
      }
    };
    walk(srcRoot);
    expect(controllers.length).toBeGreaterThan(0);
    for (const file of controllers) {
      expect({ file, hit: readFileSync(file, 'utf8').includes('recordRefund(') })
        .toEqual({ file, hit: false });
    }
  });

  it('CANCEL closes an un-executed request; approval after cancel refuses', async () => {
    const w = world();
    const req = await w.service.requestRefund(MAKER, REQ() as never);
    const cancelled = await w.service.cancelRefundRequest(
      MAKER,
      req.id as string,
    );
    expect(cancelled.state).toBe('cancelled');
    await expect(
      w.service.approveRefund(CHECKER, req.id as string),
    ).rejects.toThrow(ConflictException);
    expect(w.ledgerRows).toHaveLength(0);
  });
});
