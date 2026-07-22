// Credit Note — FIRST-CLASS FINANCIAL DOCUMENT (RC v3.0 invariant,
// founder directive at PR #88 approval).
//
// Every credit note has: a canonical reference (QN), a canonical JSON
// representation (THE source of truth), a hash derived from those
// bytes ONLY, replayability (same frozen inputs → byte-identical
// document), an audit trail, its invoice relationship, and its
// statement relationship (populated when the enumerating settlement
// statement exists — SETTLE-3b).
//
// This module is PURE (RULE 4 posture): no I/O, no clock, no
// randomness — every date is a supplied business fact. It reuses the
// statement module's canonicalJson/hashCanonical primitives so ONE
// serialization law governs every financial document.

import {
  canonicalJson,
  hashCanonical,
} from './settlement-statement';

export type CreditNoteFacts = {
  referenceNumber: string; // QN — allocated at issuance, immutable
  refundId: string;
  noteType: string; // 'merchant_goods' (fee leg = SETTLE-3b)
  invoiceType: string;
  invoiceId: string;
  merchantInvoiceNumber: string | null; // quoted — never manufactured
  merchantCreditNoteNumber: string | null; // supplied — never manufactured
  storeId: string;
  orgId: string;
  campaignId: string;
  currency: string;
  amount: number;
  vatComponent: number;
  reason: string;
  issuedAt: string; // ISO — recorded fact
  issuedBy: string;
  // Write-once when the enumerating statement exists (SETTLE-3b);
  // null until then — and the null IS part of the signed document
  // version (attaching the statement later is a NEW document version
  // event, audited, never a silent rewrite of the original bytes).
  statementSettlementId: string | null;
};

export type CreditNoteDocument = {
  documentVersion: 'v1';
  referenceNumber: string;
  refundId: string;
  noteType: string;
  invoice: {
    invoiceType: string;
    invoiceId: string;
    merchantInvoiceNumber: string | null;
  };
  merchantCreditNoteNumber: string | null;
  storeId: string;
  orgId: string;
  campaignId: string;
  currency: string;
  amount: number;
  vatComponent: number;
  reason: string;
  issuedAt: string;
  issuedBy: string;
  statementSettlementId: string | null;
};

export function buildCreditNoteDocument(
  facts: CreditNoteFacts,
): CreditNoteDocument {
  return {
    documentVersion: 'v1',
    referenceNumber: facts.referenceNumber,
    refundId: facts.refundId,
    noteType: facts.noteType,
    invoice: {
      invoiceType: facts.invoiceType,
      invoiceId: facts.invoiceId,
      merchantInvoiceNumber: facts.merchantInvoiceNumber,
    },
    merchantCreditNoteNumber: facts.merchantCreditNoteNumber,
    storeId: facts.storeId,
    orgId: facts.orgId,
    campaignId: facts.campaignId,
    currency: facts.currency,
    amount: facts.amount,
    vatComponent: facts.vatComponent,
    reason: facts.reason,
    issuedAt: facts.issuedAt,
    issuedBy: facts.issuedBy,
    statementSettlementId: facts.statementSettlementId,
  };
}

export function creditNoteCanonical(facts: CreditNoteFacts): string {
  return canonicalJson(buildCreditNoteDocument(facts));
}

// The hash derives from the CANONICAL BYTES only (invariant 2 of the
// founder directive) — one serialization, one digest.
export function creditNoteHash(facts: CreditNoteFacts): string {
  return hashCanonical(creditNoteCanonical(facts));
}
