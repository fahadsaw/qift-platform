// FINANCIAL INVARIANTS — pinned (RC v3.0, founder directive at PR #88
// approval, Track C PR 6).
//
//   INVARIANT 1 — Credit Notes are FIRST-CLASS financial documents:
//     Reference (QN) · Canonical JSON · Hash (from the canonical
//     bytes only) · Replay · Audit · Invoice relationship ·
//     Statement relationship.
//   INVARIANT 2 — Merchant Receivables are LIFECYCLE entities:
//     open / partially_recovered / recovered / written_off /
//     disputed — transitions only through the state law.
//   SEPARATION — Reserve and Receivable remain SEPARATE financial
//     concepts. Never merged.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildCreditNoteDocument,
  creditNoteCanonical,
  creditNoteHash,
  type CreditNoteFacts,
} from './settlement-credit-note';
import {
  canonicalJson,
  hashCanonical,
} from './settlement-statement';
import {
  RECEIVABLE_STATES,
  assertReceivableTransition,
  type ReceivableState,
} from './settlement-receivable-states';

const facts = (over: Partial<CreditNoteFacts> = {}): CreditNoteFacts => ({
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
  storeId: 's-daralteeb',
  orgId: 'org-nahdi',
  campaignId: 'camp-eid',
  currency: 'SAR',
  amount: 1150,
  vatComponent: 150,
  reason: 'two units damaged in transit',
  issuedAt: '2026-07-22T12:00:00.000Z',
  issuedBy: 'founder-finance',
  statementSettlementId: null,
  ...over,
});

describe('INVARIANT 1 — the credit note is a first-class financial document', () => {
  it('same frozen facts → byte-identical canonical JSON and hash, every time (Replay)', () => {
    expect(creditNoteCanonical(facts())).toBe(creditNoteCanonical(facts()));
    expect(creditNoteHash(facts())).toBe(creditNoteHash(facts()));
    // Any fact changes the document's name.
    expect(creditNoteHash(facts({ amount: 1150.01 }))).not.toBe(
      creditNoteHash(facts()),
    );
    expect(
      creditNoteHash(facts({ statementSettlementId: 'stl-1' })),
    ).not.toBe(creditNoteHash(facts()));
  });

  it('the hash derives from the canonical bytes ONLY — one serialization law for every financial document', () => {
    expect(creditNoteHash(facts())).toBe(
      hashCanonical(creditNoteCanonical(facts())),
    );
    expect(creditNoteCanonical(facts())).toBe(
      canonicalJson(buildCreditNoteDocument(facts())),
    );
  });

  it('the document carries its Reference, Invoice relationship, and Statement relationship', () => {
    const doc = buildCreditNoteDocument(facts());
    expect(doc.referenceNumber).toMatch(
      /^QN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
    );
    expect(doc.invoice).toEqual({
      invoiceType: 'merchant_invoice',
      invoiceId: 'minv-1',
      merchantInvoiceNumber: 'DAT-2026-0042', // quoted — never manufactured
      originalInvoiceNumber: 'DAT-2026-0042', // generalized original-doc number
    });
    // Statement relationship: null until the enumerating statement
    // exists (SETTLE-3b writes it once) — and the null is PART of the
    // hashed document, so late attachment is a new document version.
    expect(doc.statementSettlementId).toBeNull();
    // Format v2 = the legal-identity fields entered the hashed
    // document (C-PR8); the agent split is explicit in every document.
    expect(doc.documentVersion).toBe('v3');
    expect(doc.issuerType).toBe('MERCHANT');
    expect(doc.issuanceSource).toBe('MERCHANT');
  });

  it('purity: the credit-note law module imports ONLY the statement serialization primitives', () => {
    const src = readFileSync(
      join(__dirname, 'settlement-credit-note.ts'),
      'utf8',
    );
    const importSources = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(importSources).toEqual(['./settlement-statement']);
    for (const banned of ['Date.now(', 'new Date(', 'Math.random(', 'prisma', '@nestjs']) {
      expect({ banned, hits: src.split(banned).length - 1 }).toEqual({
        banned,
        hits: 0,
      });
    }
  });
});

describe('INVARIANT 2 — merchant receivables are lifecycle entities', () => {
  it('the state set is EXACTLY the mandated minimum', () => {
    expect([...RECEIVABLE_STATES]).toEqual([
      'open',
      'partially_recovered',
      'recovered',
      'written_off',
      'disputed',
    ]);
  });

  it('legal transitions pass; terminal states never move; everything else throws by name', () => {
    const legal: Array<[ReceivableState, ReceivableState]> = [
      ['open', 'partially_recovered'],
      ['open', 'recovered'],
      ['open', 'written_off'],
      ['open', 'disputed'],
      ['partially_recovered', 'recovered'],
      ['partially_recovered', 'written_off'],
      ['partially_recovered', 'disputed'],
      ['disputed', 'open'],
      ['disputed', 'partially_recovered'],
      ['disputed', 'written_off'],
    ];
    for (const [from, to] of legal) {
      expect(() => assertReceivableTransition(from, to)).not.toThrow();
    }
    const illegal: Array<[ReceivableState, ReceivableState]> = [
      ['recovered', 'open'],
      ['recovered', 'written_off'],
      ['written_off', 'open'],
      ['written_off', 'recovered'],
      ['partially_recovered', 'open'],
      ['disputed', 'recovered'], // resolution returns to a recovery lane first
    ];
    for (const [from, to] of illegal) {
      expect(() => assertReceivableTransition(from, to)).toThrow(
        `illegal_receivable_transition:${from}->${to}`,
      );
    }
  });
});

describe('SEPARATION — reserve and receivable are never merged', () => {
  it('the receivable lifecycle carries NO reserve state, and the schema model carries NO reserve field', () => {
    expect(
      RECEIVABLE_STATES.filter((s) => s.includes('reserve')),
    ).toEqual([]);
    const schema = readFileSync(
      join(__dirname, '../../prisma/schema.prisma'),
      'utf8',
    );
    const model = schema.split('model SettlementReceivable {')[1].split('\n}')[0];
    // Field lines only (strip the law comments explaining the
    // separation): no reserve-named column may ever appear here.
    const fieldLines = model
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'));
    expect(
      fieldLines.filter((l) => l.toLowerCase().includes('reserve')),
    ).toEqual([]);
    // And a future reserve model must not carry receivable fields —
    // when `model MerchantReserve` lands (SETTLE-3b), extend this pin
    // symmetrically before it merges.
  });
});
