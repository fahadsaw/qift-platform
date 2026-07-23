// CREDIT-NOTE LEGAL-DOCUMENT INTEGRITY — founder check (Track C PR 8).
//
// The six mandated proofs:
//   1. QN is NEVER the legal sequential document number.
//   2. Qift and merchant credit-note series cannot mix.
//   3. Merchant legal numbering requires merchant input, connector
//      input, or contractual authorization evidence.
//   4. Original-invoice linkage is mandatory.
//   5. Statement attachment never rewrites an issued document version
//      (proven in settlement-recovery.spec.ts's walkthrough against
//      the live attach path).
//   6. Canonical JSON + hash remain reproducible for every historical
//      version (same walkthrough + the replay path here).

import {
  REFERENCE_PREFIXES,
  formatSequentialReference,
} from '../references/reference';
import { SettlementRefundsService } from './settlement-refunds.service';
import {
  buildCreditNoteDocument,
  creditNoteCanonical,
  creditNoteHash,
  type CreditNoteFacts,
} from './settlement-credit-note';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { FinancialLedgerService } from '../financial/financial-ledger.service';

type Row = Record<string, unknown>;
const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';

function world() {
  let seq = 0;
  const invoice: Row = {
    id: 'minv-1',
    status: 'paid',
    totalAmount: 5750,
    vatAmount: 750,
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
    amount: 5750,
    state: 'eligible',
    batchId: null,
  };
  const refunds: Row[] = [];
  const noteVersions: Row[] = [];
  const creditNotes: Row[] = [];
  const auditRows: Row[] = [];
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
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    settlementReceivable: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
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
  const ledger = { record: jest.fn().mockResolvedValue({ id: 'l' }) };
  const service = new SettlementRefundsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    ledger as unknown as FinancialLedgerService,
    { now: () => new Date('2026-07-23T09:00:00.000Z') },
    { deriveAndApplyCoverage: jest.fn().mockResolvedValue({}) } as never,
  );
  return { service, creditNotes, noteVersions, auditRows };
}

const INPUT = (over: Row = {}) => ({
  invoiceType: 'merchant_invoice' as const,
  invoiceId: 'minv-1',
  amount: 1150,
  reason: 'legal-integrity walkthrough',
  evidenceRef: 'BANK-REF-OUT-6001',
  refundedAt: '2026-07-23T08:00:00.000Z',
  ...over,
});

describe('credit-note legal-document integrity (founder check)', () => {
  beforeAll(() => {
    process.env[GATES_ENV] = 'true';
  });
  afterAll(() => {
    delete process.env[GATES_ENV];
  });

  it('PROOF 1 — QN is the random OPERATIONAL reference, never the legal sequential number', async () => {
    // Grammar: QN is registered random; the sequential formatter
    // refuses it by kind.
    expect(REFERENCE_PREFIXES.QN.kind).toBe('random');
    expect(() => formatSequentialReference('QN', 2026, 1)).toThrow(
      /not_sequential/,
    );
    // Issuance: the QN lands in referenceNumber; the legal-number
    // column stays null-or-supplied — never QN-shaped.
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const note = w.creditNotes[0];
    expect(note.referenceNumber).toMatch(/^QN-/);
    expect(note.merchantCreditNoteNumber).toBeNull();
    // And the DOCUMENT keeps the two identities apart.
    expect(note.canonicalJson).toContain('"referenceNumber":"QN-');
    expect(note.canonicalJson).toContain('"merchantCreditNoteNumber":null');
  });

  it('PROOF 2 — the Qift series and the merchant series cannot mix (agent split explicit)', async () => {
    const w = world();
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({ issuanceSource: 'QIFT' }) as never,
      ),
    ).rejects.toThrow(
      'credit_note_series_separation:merchant_goods_never_qift_series',
    );
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({ issuanceSource: 'SOMETHING_ELSE' }) as never,
      ),
    ).rejects.toThrow('credit_note_source_unknown');
    // The lawful default records the merchant as legal issuer.
    await w.service.recordRefund('fin-1', INPUT() as never);
    expect(w.creditNotes[0]).toMatchObject({
      issuerType: 'MERCHANT',
      issuanceSource: 'MERCHANT',
    });
  });

  it('PROOF 3 — Qift may write a merchant legal number ONLY with contractual authorization evidence', async () => {
    const w = world();
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({
          issuanceSource: 'QIFT_ON_BEHALF',
          merchantCreditNoteNumber: 'DAT-CN-0007',
        }) as never,
      ),
    ).rejects.toThrow('on_behalf_requires_authorization_evidence');
    await expect(
      w.service.recordRefund(
        'fin-1',
        INPUT({
          issuanceSource: 'QIFT_ON_BEHALF',
          onBehalfAuthorizationRef: 'CONTRACT-2026-DAT-§9.2',
        }) as never,
      ),
    ).rejects.toThrow('on_behalf_requires_legal_number');
    const ok = await w.service.recordRefund(
      'fin-1',
      INPUT({
        issuanceSource: 'QIFT_ON_BEHALF',
        merchantCreditNoteNumber: 'DAT-CN-0007',
        onBehalfAuthorizationRef: 'CONTRACT-2026-DAT-§9.2',
      }) as never,
    );
    expect(ok.replayed).toBe(false);
    expect(w.creditNotes[0]).toMatchObject({
      issuerType: 'MERCHANT', // still the merchant's document
      issuanceSource: 'QIFT_ON_BEHALF',
      merchantCreditNoteNumber: 'DAT-CN-0007',
      onBehalfAuthorizationRef: 'CONTRACT-2026-DAT-§9.2',
    });
    // The evidence is INSIDE the hashed document.
    expect(w.creditNotes[0].canonicalJson).toContain(
      'CONTRACT-2026-DAT-§9.2',
    );
  });

  it('PROOF 4 — original-invoice linkage is mandatory and rides the hashed document', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const note = w.creditNotes[0];
    expect(note.invoiceId).toBe('minv-1');
    expect(note.originalInvoiceNumber).toBe('DAT-2026-0042');
    const doc = buildCreditNoteDocument({
      referenceNumber: note.referenceNumber,
      refundId: note.refundId,
      noteType: note.noteType,
      invoiceType: note.invoiceType,
      invoiceId: note.invoiceId,
      merchantInvoiceNumber: note.merchantInvoiceNumber,
      merchantCreditNoteNumber: note.merchantCreditNoteNumber,
      issuerType: note.issuerType,
      issuanceSource: note.issuanceSource,
      onBehalfAuthorizationRef: note.onBehalfAuthorizationRef,
      creditNoteUuid: note.creditNoteUuid,
      originalInvoiceNumber: note.originalInvoiceNumber,
      qiftCreditNoteNumber: note.qiftCreditNoteNumber ?? null,
      netComponent: note.netComponent ?? null,
      reasonCode: note.reasonCode ?? null,
      taxRuleVersion: note.taxRuleVersion ?? null,
      buyerSnapshot: note.buyerSnapshot ?? null,
      issuerSnapshot: note.issuerSnapshot ?? null,

      storeId: note.storeId,
      orgId: note.orgId,
      campaignId: note.campaignId,
      currency: note.currency,
      amount: note.amount,
      vatComponent: note.vatComponent,
      reason: note.reason,
      issuedAt: (note.issuedAt as Date).toISOString(),
      issuedBy: note.issuedBy,
      statementSettlementId: null,
    } as CreditNoteFacts);
    expect(doc.invoice.invoiceId).toBe('minv-1');
    expect(doc.invoice.originalInvoiceNumber).toBe('DAT-2026-0042');
  });

  it('PROOF 6 (issuance half) — version 1 is appended at issuance and reproduces byte-for-byte', async () => {
    const w = world();
    await w.service.recordRefund('fin-1', INPUT() as never);
    const note = w.creditNotes[0];
    expect(w.noteVersions).toHaveLength(1);
    expect(w.noteVersions[0]).toMatchObject({
      versionNumber: 1,
      changeReason: 'issued',
      statementSettlementId: null,
    });
    // Reproducibility: the stored v1 bytes regenerate from the row's
    // as-of-v1 facts (statementSettlementId null).
    const facts = {
      referenceNumber: note.referenceNumber,
      refundId: note.refundId,
      noteType: note.noteType,
      invoiceType: note.invoiceType,
      invoiceId: note.invoiceId,
      merchantInvoiceNumber: note.merchantInvoiceNumber,
      merchantCreditNoteNumber: note.merchantCreditNoteNumber,
      issuerType: note.issuerType,
      issuanceSource: note.issuanceSource,
      onBehalfAuthorizationRef: note.onBehalfAuthorizationRef,
      creditNoteUuid: note.creditNoteUuid,
      originalInvoiceNumber: note.originalInvoiceNumber,
      qiftCreditNoteNumber: note.qiftCreditNoteNumber ?? null,
      netComponent: note.netComponent ?? null,
      reasonCode: note.reasonCode ?? null,
      taxRuleVersion: note.taxRuleVersion ?? null,
      buyerSnapshot: note.buyerSnapshot ?? null,
      issuerSnapshot: note.issuerSnapshot ?? null,

      storeId: note.storeId,
      orgId: note.orgId,
      campaignId: note.campaignId,
      currency: note.currency,
      amount: note.amount,
      vatComponent: note.vatComponent,
      reason: note.reason,
      issuedAt: (note.issuedAt as Date).toISOString(),
      issuedBy: note.issuedBy,
      statementSettlementId: null,
    } as CreditNoteFacts;
    expect(w.noteVersions[0].canonicalJson).toBe(creditNoteCanonical(facts));
    expect(w.noteVersions[0].documentHash).toBe(creditNoteHash(facts));
  });
});
