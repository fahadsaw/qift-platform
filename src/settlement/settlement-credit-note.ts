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
  referenceNumber: string; // QN — operational ONLY, never the legal number
  refundId: string;
  noteType: string; // 'merchant_goods' (fee leg future)
  invoiceType: string;
  invoiceId: string;
  merchantInvoiceNumber: string | null; // quoted — never manufactured
  merchantCreditNoteNumber: string | null; // supplied — never manufactured
  // Qift's OWN sequential legal number (RC v4.0 QD series) — the fee
  // leg only; never on a merchant-goods note (series separation).
  qiftCreditNoteNumber: string | null;
  // Legal-document identity (C-PR8): the agent split, explicit.
  issuerType: string; // 'MERCHANT' | 'QIFT'
  issuanceSource: string; // MERCHANT | ACCOUNTING_CONNECTOR | QIFT_ON_BEHALF | QIFT
  onBehalfAuthorizationRef: string | null;
  creditNoteUuid: string | null; // future ZATCA
  originalInvoiceNumber: string | null; // generalized original-document number
  // Fee-leg legal freeze (C-PR9): the net component (amount −
  // vatComponent, stored — the document never derives), the closed
  // refund reasonCode, the ORIGINAL invoice's frozen tax-rule
  // version, and the party snapshots quoted from the invoice.
  netComponent: number | null;
  reasonCode: string | null;
  taxRuleVersion: string | null;
  buyerSnapshot: unknown | null;
  issuerSnapshot: unknown | null;
  storeId: string | null; // null on the Qift fee leg
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
  // FORMAT version (v3 as of C-PR9: the fee-leg legal freeze —
  // qiftCreditNoteNumber, netComponent, reasonCode, taxRuleVersion,
  // party snapshots — entered the hashed document; v2 added the
  // legal-identity fields. No earlier-format documents exist
  // anywhere: the Ch. 17.4 gates were never attested).
  documentVersion: 'v3';
  referenceNumber: string;
  refundId: string;
  noteType: string;
  invoice: {
    invoiceType: string;
    invoiceId: string;
    merchantInvoiceNumber: string | null;
    originalInvoiceNumber: string | null;
  };
  issuerType: string;
  issuanceSource: string;
  onBehalfAuthorizationRef: string | null;
  creditNoteUuid: string | null;
  merchantCreditNoteNumber: string | null;
  qiftCreditNoteNumber: string | null;
  netComponent: number | null;
  reasonCode: string | null;
  taxRuleVersion: string | null;
  buyerSnapshot: unknown | null;
  issuerSnapshot: unknown | null;
  storeId: string | null; // null on the Qift fee leg
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
    documentVersion: 'v3',
    referenceNumber: facts.referenceNumber,
    refundId: facts.refundId,
    noteType: facts.noteType,
    invoice: {
      invoiceType: facts.invoiceType,
      invoiceId: facts.invoiceId,
      merchantInvoiceNumber: facts.merchantInvoiceNumber,
      originalInvoiceNumber: facts.originalInvoiceNumber,
    },
    issuerType: facts.issuerType,
    issuanceSource: facts.issuanceSource,
    onBehalfAuthorizationRef: facts.onBehalfAuthorizationRef,
    creditNoteUuid: facts.creditNoteUuid,
    merchantCreditNoteNumber: facts.merchantCreditNoteNumber,
    qiftCreditNoteNumber: facts.qiftCreditNoteNumber,
    netComponent: facts.netComponent,
    reasonCode: facts.reasonCode,
    taxRuleVersion: facts.taxRuleVersion,
    buyerSnapshot: facts.buyerSnapshot ?? null,
    issuerSnapshot: facts.issuerSnapshot ?? null,
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
