// SETTLE-3a refunds (Track C PR 5) — SC v2.0 §8, executable.
//
//   §8.1 A refund follows the seller of the refunded leg. This PR
//        implements the GOODS leg (merchant's money, safeguarding);
//        the fee leg (Qift's own money) is SETTLE-3b — refused
//        loudly, never silently misallocated.
//   §8.2 Every refund is a credit-note DOCUMENT against the original
//        invoice (FC Ch. 4.5) + its taxonomy event, anchored on the
//        refundId occurrence. Documents immutable; the merchant's
//        legal credit-note number is SUPPLIED, never manufactured.
//   §8.3 Tax rides the line: the VAT component reverses at the
//        ORIGINAL frozen proportions (integer minor units, half-up) —
//        never today's rates.
//   §8.4 Settlement interaction:
//          pre-settlement  → the item REDUCES (or empties);
//          bound to a ready batch → REFUSED: recomposition is the
//          supersession lane (§33.3 — never batch surgery);
//          post-settlement → merchant receivable accrues (§2
//          Reversed flow); the item flips settled→reversed when
//          fully clawed back. Recovery by offset (§7.4) lands with
//          SETTLE-3b's assembly integration.
//   §8.5 Refunds never touch prior statements — the NEXT statement
//        enumerates them (via the §4 lines when recovery lands).
//
// RECORDED DECISIONS (SETTLE-3b revisits): a fully-refunded item
// shrinks to amount 0 and stays in its state (no lawful
// zero/removed state exists yet — a 0-line occurrence on a future
// batch is harmless but odd); the merchant's LATE-supplied credit-
// note legal number has no attach surface yet (rows are immutable) —
// both tracked for SETTLE-3b.
//
// Over-refund is impossible: Σ refunds may never exceed Σ receipts
// for the invoice, guarded INSIDE a Serializable transaction (the
// receipts pattern). Money leaves safeguarding only per posted,
// evidenced facts (§13.3).
//
// RULE 1: all money math in the settlement module. RULE 2: clock
// injected; refundedAt is supplied evidence, window-bounded like
// remittances (§32.3 defense).

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FinancialLedgerService } from '../financial/financial-ledger.service';
import {
  FINANCIAL_EVENTS,
  ledgerIdempotencyKey,
} from '../financial/financial-events';
import { moneyToNumber, toMinor, fromMinor } from '../fees/money';
import {
  allocateReference,
  formatSequentialReference,
} from '../references/reference';
import { SETTLEMENT_CLOCK, type SettlementClock } from './settlement-clock';
import { SettlementReceiptsService } from './settlement-receipts.service';
import {
  creditNoteCanonical,
  creditNoteHash,
  type CreditNoteFacts,
} from './settlement-credit-note';
import { assertItemTransition, type ItemState } from './settlement-states';
import { APPROVAL_POLICY } from './settlement-approval-policy';

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
const HOUR_MS = 60 * 60 * 1000;

export type RecordRefundInput = {
  invoiceType: 'merchant_invoice' | 'corporate_invoice';
  invoiceId: string;
  amount: number; // gross refunded, incl. VAT component
  reason: string;
  evidenceRef: string; // bank reference of the outbound movement
  refundedAt: string; // ISO value date — business fact
  merchantCreditNoteNumber?: string; // SUPPLIED, never manufactured
  // How the merchant legal number was sourced (C-PR8 legal identity):
  // 'MERCHANT' (default when supplied) | 'ACCOUNTING_CONNECTOR' |
  // 'QIFT_ON_BEHALF' (REQUIRES onBehalfAuthorizationRef). 'QIFT' is
  // the fee-leg series and is REFUSED on merchant-goods notes.
  issuanceSource?: string;
  onBehalfAuthorizationRef?: string;
  // Fee leg (C-PR9): closed refund reason vocabulary, REQUIRED there.
  reasonCode?: string;
};

// Closed fee-refund reason vocabulary (C-PR9) — grows only by PR.
const FEE_REFUND_REASON_CODES: ReadonlySet<string> = new Set([
  'service_not_rendered',
  'billing_error',
  'campaign_cancelled',
  'goodwill',
  'other',
]);

const MERCHANT_NUMBER_SOURCES: ReadonlySet<string> = new Set([
  'MERCHANT',
  'ACCOUNTING_CONNECTOR',
  'QIFT_ON_BEHALF',
]);

@Injectable()
export class SettlementRefundsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
    // SETTLE-3c-1 (review finding 2): a pre-payment credit can
    // complete coverage — the refunds path re-derives it.
    private receipts: SettlementReceiptsService,
  ) {}

  async recordRefund(actorUserId: string, input: RecordRefundInput) {
    this.assertGatesOpen();
    if (input.invoiceType === 'corporate_invoice') {
      // §8.1: the fee leg is Qift's OWN money — its own legal series
      // (QD), its own postings, its own account. SETTLE-3c-1.
      return this.recordFeeRefund(actorUserId, input);
    }
    if (input.invoiceType !== 'merchant_invoice') {
      throw new BadRequestException('refund_invoice_type_unknown');
    }
    if (typeof input.invoiceId !== 'string' || !input.invoiceId.trim()) {
      throw new BadRequestException('refund_invoice_id_required');
    }
    const evidenceRef =
      typeof input.evidenceRef === 'string' ? input.evidenceRef.trim() : '';
    if (!evidenceRef) {
      throw new BadRequestException('refund_evidence_required');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) {
      throw new BadRequestException('refund_reason_required');
    }
    const refundedAt = new Date(input.refundedAt);
    if (Number.isNaN(refundedAt.getTime())) {
      throw new BadRequestException('refund_refunded_at_invalid');
    }
    const nowMs = this.clock.now().getTime();
    if (
      nowMs - refundedAt.getTime() >
        APPROVAL_POLICY.executedAtMaxAgeHours * HOUR_MS ||
      refundedAt.getTime() - nowMs >
        APPROVAL_POLICY.executedAtMaxSkewHours * HOUR_MS
    ) {
      throw new BadRequestException('refund_refunded_at_out_of_window');
    }
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
      throw new BadRequestException('refund_amount_must_be_positive');
    }
    const amountMinor = toMinor(input.amount, 'SAR');
    if (amountMinor <= 0) {
      throw new BadRequestException('refund_amount_must_be_positive');
    }
    const amount = fromMinor(amountMinor, 'SAR');

    let outcome;
    try {
      outcome = await this.withSerializableRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            const invoice = await tx.merchantInvoice.findUnique({
              where: { id: input.invoiceId },
            });
            if (!invoice) throw new NotFoundException('invoice_not_found');
            if (invoice.currency !== 'SAR') {
              throw new BadRequestException('refund_currency_unsupported');
            }
            // §18.1 replay FIRST (the receipts pattern): the same
            // outbound movement collides by identity, never balance.
            const existing = await tx.settlementRefund.findUnique({
              where: {
                invoiceType_invoiceId_evidenceRef: {
                  invoiceType: 'merchant_invoice',
                  invoiceId: invoice.id,
                  evidenceRef,
                },
              },
            });
            if (existing) {
              return { existing, refund: null, interaction: null };
            }
            // §5.1: refunds return COLLECTED money — the invoice must
            // be fully paid (partial-coverage refunds wait for the
            // coverage to complete or the receipt to be corrected).
            if (invoice.status !== 'paid') {
              throw new BadRequestException(
                `refund_requires_paid_invoice:${invoice.status}`,
              );
            }
            // Over-refund guard: Σ refunds + this one ≤ Σ receipts.
            const receipts = await tx.paymentReceipt.findMany({
              where: {
                invoiceType: 'merchant_invoice',
                invoiceId: invoice.id,
              },
              select: { amount: true },
            });
            const receivedMinor = receipts.reduce(
              (s, r) => s + toMinor(moneyToNumber(r.amount), 'SAR'),
              0,
            );
            const refunds = await tx.settlementRefund.findMany({
              where: {
                invoiceType: 'merchant_invoice',
                invoiceId: invoice.id,
              },
              select: {
                amount: true,
                vatComponent: true,
                settlementInteraction: true,
              },
            });
            const refundedMinor = refunds.reduce(
              (s, r) => s + toMinor(moneyToNumber(r.amount), 'SAR'),
              0,
            );
            if (refundedMinor + amountMinor > receivedMinor) {
              throw new ConflictException('refund_exceeds_collected');
            }

            // §8.3: VAT reverses at the ORIGINAL frozen proportion —
            // integer minor units, half-up, from the invoice's frozen
            // vatAmount/totalAmount. Never today's rates.
            const totalMinor = toMinor(moneyToNumber(invoice.totalAmount), 'SAR');
            const vatMinor = toMinor(moneyToNumber(invoice.vatAmount), 'SAR');
            // Per-part half-up rounding is independent, so the parts of
            // a split refund could sum a halala past the invoice's
            // frozen VAT — capped here at the REMAINING frozen VAT
            // (review finding 4): Σ credit-note VAT never exceeds the
            // invoice's.
            const priorVatMinor = refunds.reduce(
              (t, r) => t + toMinor(moneyToNumber(r.vatComponent), 'SAR'),
              0,
            );
            // Completing refund absorbs the VAT remainder (finding 4).
            const vatComponentMinor =
              refundedMinor + amountMinor === totalMinor
                ? Math.min(amountMinor, Math.max(0, vatMinor - priorVatMinor))
                : Math.min(
                    totalMinor === 0
                      ? 0
                      : Math.floor(
                          (amountMinor * vatMinor +
                            Math.floor(totalMinor / 2)) /
                            totalMinor,
                        ),
                    Math.max(0, vatMinor - priorVatMinor),
                  );
            const vatComponent = fromMinor(vatComponentMinor, 'SAR');

            // §8.4 settlement interaction, decided on the item's state.
            const item = await tx.settlementItem.findUnique({
              where: {
                occurrenceType_occurrenceId: {
                  occurrenceType: 'merchant_invoice',
                  occurrenceId: invoice.id,
                },
              },
            });
            if (!item) {
              // A paid goods invoice without its settlement item is a
              // §18.3 inconsistency the repair path owns.
              throw new ConflictException('settlement_item_missing');
            }
            let interaction: 'item_reduced' | 'receivable_accrued';
            const state = item.state as ItemState;
            if (state === 'ready') {
              // Bound to an unexecuted batch: recomposition is the
              // supersession lane (§33.3), never in-place surgery.
              throw new ConflictException('item_bound_supersede_first');
            } else if (state === 'disputed') {
              // §16.2: the dispute lane owns frozen money.
              throw new ConflictException('item_disputed');
            } else if (state === 'settled' || state === 'reversed') {
              interaction = 'receivable_accrued';
            } else {
              // pending | eligible | held — the money never left; the
              // item simply shrinks (§8.4). Guarded on the read state.
              interaction = 'item_reduced';
              const newAmount = fromMinor(
                toMinor(moneyToNumber(item.amount), 'SAR') - amountMinor,
                'SAR',
              );
              if (newAmount < 0) {
                // Cannot shrink below zero: the excess is not in this
                // item (it was already refunded or never collected).
                throw new ConflictException('refund_exceeds_item');
              }
              const shrunk = await tx.settlementItem.updateMany({
                where: { id: item.id, state: item.state, batchId: null },
                data: { amount: newAmount },
              });
              if (shrunk.count !== 1) {
                throw new ConflictException('settlement_items_contended');
              }
            }

            const refund = await tx.settlementRefund.create({
              data: {
                invoiceType: 'merchant_invoice',
                invoiceId: invoice.id,
                storeId: invoice.storeId,
                orgId: invoice.orgId,
                campaignId: invoice.campaignId,
                currency: 'SAR',
                amount,
                vatComponent,
                reason,
                evidenceRef,
                refundedAt,
                recordedBy: actorUserId,
                settlementInteraction: interaction,
              },
            });
            // FC Ch. 4.5 + RC v3.0: the credit-note DOCUMENT is
            // FIRST-CLASS — QN reference minted at issuance (single
            // mint site), canonical JSON stored as the source of
            // truth, hash from those bytes only. The merchant's legal
            // number is supplied, never manufactured.
            // C-PR8 legal-identity law (agent model): the goods
            // credit note is the MERCHANT'S legal document. Its
            // number arrives from the merchant, their connector, or
            // Qift acting ON BEHALF under contractual authorization
            // evidence — never from Qift's own series, never
            // manufactured.
            const issuanceSource = input.issuanceSource ?? 'MERCHANT';
            if (issuanceSource === 'QIFT') {
              throw new BadRequestException(
                'credit_note_series_separation:merchant_goods_never_qift_series',
              );
            }
            if (!MERCHANT_NUMBER_SOURCES.has(issuanceSource)) {
              throw new BadRequestException('credit_note_source_unknown');
            }
            const onBehalfRef = input.onBehalfAuthorizationRef?.trim() || null;
            if (issuanceSource === 'QIFT_ON_BEHALF') {
              if (!input.merchantCreditNoteNumber?.trim()) {
                throw new BadRequestException(
                  'on_behalf_requires_legal_number',
                );
              }
              if (!onBehalfRef) {
                throw new BadRequestException(
                  'on_behalf_requires_authorization_evidence',
                );
              }
            }
            const referenceNumber = await this.mintQn(tx);
            const issuedAtIso = this.clock.now();
            const facts: CreditNoteFacts = {
              referenceNumber,
              refundId: refund.id,
              noteType: 'merchant_goods',
              invoiceType: 'merchant_invoice',
              invoiceId: invoice.id,
              merchantInvoiceNumber: invoice.merchantInvoiceNumber,
              merchantCreditNoteNumber:
                input.merchantCreditNoteNumber?.trim() || null,
              issuerType: 'MERCHANT',
              issuanceSource,
              onBehalfAuthorizationRef: onBehalfRef,
              creditNoteUuid: null,
              originalInvoiceNumber: invoice.merchantInvoiceNumber,
              qiftCreditNoteNumber: null, // goods leg NEVER carries QD
              netComponent: null,
              reasonCode: null,
              taxRuleVersion: null,
              buyerSnapshot: null,
              issuerSnapshot: null,
              storeId: invoice.storeId,
              orgId: invoice.orgId,
              campaignId: invoice.campaignId,
              currency: 'SAR',
              amount,
              vatComponent,
              reason,
              issuedAt: issuedAtIso.toISOString(),
              issuedBy: actorUserId,
              statementSettlementId: null,
            };
            const canonical = creditNoteCanonical(facts);
            const documentHash = creditNoteHash(facts);
            const note = await tx.creditNote.create({
              data: {
                referenceNumber,
                refundId: refund.id,
                noteType: 'merchant_goods',
                invoiceType: 'merchant_invoice',
                invoiceId: invoice.id,
                merchantInvoiceNumber: invoice.merchantInvoiceNumber,
                merchantCreditNoteNumber:
                  input.merchantCreditNoteNumber?.trim() || null,
                issuerType: 'MERCHANT',
                issuanceSource,
                onBehalfAuthorizationRef: onBehalfRef,
                creditNoteUuid: null,
                originalInvoiceNumber: invoice.merchantInvoiceNumber,
                currentVersion: 1,
                storeId: invoice.storeId,
                orgId: invoice.orgId,
                campaignId: invoice.campaignId,
                currency: 'SAR',
                amount,
                vatComponent,
                reason,
                issuedAt: issuedAtIso,
                issuedBy: actorUserId,
                canonicalJson: canonical,
                documentHash,
              },
            });
            // APPEND-ONLY version history (C-PR8): version 1 = the
            // issued document, preserved byte-for-byte forever.
            await tx.creditNoteVersion.create({
              data: {
                creditNoteId: note.id,
                versionNumber: 1,
                changeReason: 'issued',
                canonicalJson: canonical,
                documentHash,
                statementSettlementId: null,
                createdBy: actorUserId,
              },
            });
            // The MONEY fact (§8.4): goods refund leaves safeguarding.
            await this.ledger.record(
              {
                eventType: FINANCIAL_EVENTS.REFUND_PAID,
                reasonCode: 'REFUND_GOODS',
                actorType: 'user',
                actorId: actorUserId,
                amount,
                currency: 'SAR',
                direction: 'debit',
                counterpartyType: 'company',
                campaignId: invoice.campaignId,
                orgId: invoice.orgId,
                storeId: invoice.storeId,
                idempotencyKey: ledgerIdempotencyKey(
                  FINANCIAL_EVENTS.REFUND_PAID,
                  refund.id,
                ),
                metadata: {
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.merchantInvoiceNumber,
                  evidenceRef,
                  // §13.3: pre-settlement goods refunds return client
                  // money from SAFEGUARDING; post-settlement the
                  // money already left to the merchant — Qift FRONTS
                  // the refund from OPERATING pending §7.4 recovery
                  // (the recovery draw repays operating).
                  account:
                    interaction === 'receivable_accrued'
                      ? 'operating'
                      : 'safeguarding',
                  passThrough: true,
                  settlementInteraction: interaction,
                  vatComponent,
                },
              },
              tx,
            );
            if (interaction === 'receivable_accrued') {
              // §2 Reversed: the merchant owes the clawed-back goods
              // money — an OPEN receivable recovered by §7.4 offset
              // (SETTLE-3b assembly lines).
              await tx.settlementReceivable.create({
                data: {
                  storeId: invoice.storeId,
                  currency: 'SAR',
                  amount,
                  occurrenceType: 'refund',
                  occurrenceId: refund.id,
                  state: 'open',
                  accruedAt: this.clock.now(),
                },
              });
              await this.ledger.record(
                {
                  eventType: FINANCIAL_EVENTS.MERCHANT_RECEIVABLE_ACCRUED,
                  reasonCode: 'MERCHANT_RECEIVABLE',
                  actorType: 'user',
                  actorId: actorUserId,
                  amount,
                  currency: 'SAR',
                  direction: 'credit', // value Qift is OWED (asset form)
                  counterpartyType: 'merchant',
                  storeId: invoice.storeId,
                  idempotencyKey: ledgerIdempotencyKey(
                    FINANCIAL_EVENTS.MERCHANT_RECEIVABLE_ACCRUED,
                    refund.id,
                  ),
                  metadata: {
                    refundId: refund.id,
                    invoiceId: invoice.id,
                    invoiceNumber: invoice.merchantInvoiceNumber,
                  },
                },
                tx,
              );
              // Fully clawed back ⇒ the settled item flips Reversed
              // (§2). Partial clawbacks leave it settled — the
              // receivable carries the exact amount owed.
              // The flip counts POST-SETTLEMENT clawbacks ONLY (review
              // finding 2): pre-settlement reductions already shrank
              // item.amount — counting them again would flip Reversed
              // while settled money remains un-clawed.
              const clawedMinor =
                refunds
                  .filter(
                    (r) => r.settlementInteraction === 'receivable_accrued',
                  )
                  .reduce(
                    (t, r) => t + toMinor(moneyToNumber(r.amount), 'SAR'),
                    0,
                  ) + amountMinor;
              const itemMinor = toMinor(moneyToNumber(item.amount), 'SAR');
              if (state === 'settled' && clawedMinor >= itemMinor) {
                assertItemTransition('settled', 'reversed');
                const flipped = await tx.settlementItem.updateMany({
                  where: { id: item.id, state: 'settled' },
                  data: { state: 'reversed' },
                });
                if (flipped.count !== 1) {
                  throw new ConflictException('settlement_items_contended');
                }
              }
            }
            return { existing: null, refund, interaction };
          },
          { isolationLevel: 'Serializable' },
        ),
      );
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        // Concurrent identical submissions: both passed the in-tx
        // replay read; the loser's insert collides on the evidence
        // unique — a lawful §18.1 replay, resolved by identity
        // (review finding 3; the receipts pattern).
        const existing = await this.prisma.settlementRefund.findUnique({
          where: {
            invoiceType_invoiceId_evidenceRef: {
              invoiceType: 'merchant_invoice',
              invoiceId: input.invoiceId,
              evidenceRef,
            },
          },
        });
        if (existing) {
          outcome = { existing, refund: null, interaction: null };
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
    if (outcome.existing) {
      // §18.1 replay: identity check — a DIFFERENT movement reusing
      // the evidence reference is refused loudly.
      if (
        toMinor(moneyToNumber(outcome.existing.amount), 'SAR') !==
          amountMinor ||
        outcome.existing.refundedAt.getTime() !== refundedAt.getTime()
      ) {
        throw new ConflictException('refund_evidence_conflict');
      }
      return { refund: outcome.existing, replayed: true as const };
    }
    const issuedNote = await this.prisma.creditNote.findUnique({
      where: { refundId: outcome.refund!.id },
      select: { referenceNumber: true },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'finance.credit_note.issued',
      targetType: 'store',
      targetId: outcome.refund!.storeId,
      metadata: {
        creditNoteReference: issuedNote?.referenceNumber,
        refundId: outcome.refund!.id,
        invoiceId: outcome.refund!.invoiceId,
        amount,
        vatComponent: moneyToNumber(outcome.refund!.vatComponent),
      },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'finance.refund.recorded',
      targetType: 'store',
      targetId: outcome.refund!.storeId,
      metadata: {
        refundId: outcome.refund!.id,
        invoiceType: 'merchant_invoice',
        invoiceId: outcome.refund!.invoiceId,
        amount,
        vatComponent: moneyToNumber(outcome.refund!.vatComponent),
        currency: 'SAR',
        reason,
        evidenceRef,
        settlementInteraction: outcome.interaction,
      },
    });
    return { refund: outcome.refund!, replayed: false as const };
  }

  // Read models: refunds per invoice; open receivables per store.
  async listRefunds(invoiceType: string, invoiceId: string) {
    if (
      invoiceType !== 'merchant_invoice' &&
      invoiceType !== 'corporate_invoice'
    ) {
      throw new BadRequestException('refund_invoice_type_unknown');
    }
    if (typeof invoiceId !== 'string' || !invoiceId.trim()) {
      throw new BadRequestException('refund_invoice_id_required');
    }
    const refunds = await this.prisma.settlementRefund.findMany({
      where: { invoiceType, invoiceId },
      orderBy: [{ refundedAt: 'asc' }, { id: 'asc' }],
    });
    const creditNotes = await this.prisma.creditNote.findMany({
      where: { invoiceType, invoiceId },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    });
    return { invoiceType, invoiceId, refunds, creditNotes };
  }

  // RC v3.0: replay a credit note — regenerate the document from its
  // frozen facts through the pure builder and compare canonical bytes
  // and hash. Integrity is verified BEFORE any rendering; a tampered
  // row is surfaced, never rendered as authentic.
  async replayCreditNote(actorUserId: string, refundId: string) {
    if (typeof refundId !== 'string' || !refundId.trim()) {
      throw new BadRequestException('refund_id_required');
    }
    const note = await this.prisma.creditNote.findUnique({
      where: { refundId },
    });
    if (!note) throw new NotFoundException('credit_note_not_found');
    const facts: CreditNoteFacts = {
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
      qiftCreditNoteNumber: note.qiftCreditNoteNumber,
      netComponent: note.netComponent === null ? null : moneyToNumber(note.netComponent),
      reasonCode: note.reasonCode,
      taxRuleVersion: note.taxRuleVersion,
      buyerSnapshot: note.buyerSnapshot ?? null,
      issuerSnapshot: note.issuerSnapshot ?? null,
      storeId: note.storeId,
      orgId: note.orgId,
      campaignId: note.campaignId,
      currency: note.currency,
      amount: moneyToNumber(note.amount),
      vatComponent: moneyToNumber(note.vatComponent),
      reason: note.reason,
      issuedAt: note.issuedAt.toISOString(),
      issuedBy: note.issuedBy,
      statementSettlementId: note.statementSettlementId,
    };
    const regeneratedCanonical = creditNoteCanonical(facts);
    const regeneratedHash = creditNoteHash(facts);
    const canonicalIdentical = regeneratedCanonical === note.canonicalJson;
    const hashIdentical = regeneratedHash === note.documentHash;
    const identical = canonicalIdentical && hashIdentical;
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.credit_note.replayed',
      // Fee-leg notes have no store party — target the organization.
      targetType: note.storeId ? 'store' : 'organization',
      targetId: note.storeId ?? note.orgId,
      metadata: {
        creditNoteReference: note.referenceNumber,
        refundId,
        documentVersion: 'v3',
        identical,
      },
    });
    return {
      creditNoteReference: note.referenceNumber,
      documentVersion: 'v3' as const,
      identical,
      canonicalIdentical,
      hashIdentical,
      storedHash: note.documentHash,
      regeneratedHash,
    };
  }

  async openReceivables(storeId?: string) {
    const rows = await this.prisma.settlementReceivable.findMany({
      where: { state: 'open', ...(storeId ? { storeId } : {}) },
      orderBy: [{ accruedAt: 'asc' }, { id: 'asc' }],
    });
    return { asOf: this.clock.now().toISOString(), receivables: rows };
  }

  // ── SETTLE-3c-1: the Qift service-fee leg ─────────────────────────
  // Qift is the LEGAL ISSUER (agent model): its OWN sequential QD
  // series (RC v4.0), its own postings, its own account. The FROZEN
  // Qift invoice is the only source of truth — nothing here consults
  // the live FeeEngine, TaxEngine, campaign, org, or store.
  //
  //   invoice 'issued'  → PRE-PAYMENT credit: reduces the unpaid
  //     receivable (refund.approved postings; no cash moves).
  //   invoice 'paid'    → POST-PAYMENT refund: cash returns from
  //     OPERATING (refund.paid) + compensating revenue reversal +
  //     VAT reversal at the frozen proportion.
  //
  // Agent-model law (pinned): NEVER touches MerchantPayable,
  // MerchantReceivable, reserves, or any merchant/store money.
  private async recordFeeRefund(actorUserId: string, input: RecordRefundInput) {
    if (typeof input.invoiceId !== 'string' || !input.invoiceId.trim()) {
      throw new BadRequestException('refund_invoice_id_required');
    }
    const evidenceRef =
      typeof input.evidenceRef === 'string' ? input.evidenceRef.trim() : '';
    if (!evidenceRef) {
      throw new BadRequestException('refund_evidence_required');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) {
      throw new BadRequestException('refund_reason_required');
    }
    const reasonCode = input.reasonCode?.trim() ?? '';
    if (!FEE_REFUND_REASON_CODES.has(reasonCode)) {
      throw new BadRequestException('fee_refund_reason_code_required');
    }
    if (input.merchantCreditNoteNumber || input.onBehalfAuthorizationRef) {
      // Series separation, both directions: a Qift document never
      // carries a merchant legal number.
      throw new BadRequestException(
        'credit_note_series_separation:fee_leg_never_merchant_series',
      );
    }
    const refundedAt = new Date(input.refundedAt);
    if (Number.isNaN(refundedAt.getTime())) {
      throw new BadRequestException('refund_refunded_at_invalid');
    }
    const nowMs = this.clock.now().getTime();
    if (
      nowMs - refundedAt.getTime() >
        APPROVAL_POLICY.executedAtMaxAgeHours * HOUR_MS ||
      refundedAt.getTime() - nowMs >
        APPROVAL_POLICY.executedAtMaxSkewHours * HOUR_MS
    ) {
      throw new BadRequestException('refund_refunded_at_out_of_window');
    }
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
      throw new BadRequestException('refund_amount_must_be_positive');
    }
    const amountMinor = toMinor(input.amount, 'SAR');
    if (amountMinor <= 0) {
      throw new BadRequestException('refund_amount_must_be_positive');
    }
    const amount = fromMinor(amountMinor, 'SAR');

    let outcome;
    try {
      outcome = await this.withSerializableRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            const invoice = await tx.corporateInvoice.findUnique({
            where: { id: input.invoiceId },
          });
          if (!invoice) throw new NotFoundException('invoice_not_found');
          if (invoice.currency !== 'SAR') {
            throw new BadRequestException('refund_currency_unsupported');
          }
          // §18.1 replay FIRST — identity, never balance.
          const existing = await tx.settlementRefund.findUnique({
            where: {
              invoiceType_invoiceId_evidenceRef: {
                invoiceType: 'corporate_invoice',
                invoiceId: invoice.id,
                evidenceRef,
              },
            },
          });
          if (existing) {
            return { existing, refund: null, note: null };
          }
          if (invoice.status !== 'issued' && invoice.status !== 'paid') {
            throw new BadRequestException(
              `refund_requires_active_invoice:${invoice.status}`,
            );
          }
          const totalMinor = toMinor(moneyToNumber(invoice.totalAmount), 'SAR');
          const vatMinor = toMinor(
            moneyToNumber(invoice.vatAmount ?? 0),
            'SAR',
          );
          const receipts = await tx.paymentReceipt.findMany({
            where: {
              invoiceType: 'corporate_invoice',
              invoiceId: invoice.id,
            },
            select: { amount: true },
          });
          const receivedMinor = receipts.reduce(
            (t, r) => t + toMinor(moneyToNumber(r.amount), 'SAR'),
            0,
          );
          const priorRefunds = await tx.settlementRefund.findMany({
            where: {
              invoiceType: 'corporate_invoice',
              invoiceId: invoice.id,
            },
            select: {
              amount: true,
              vatComponent: true,
              settlementInteraction: true,
            },
          });
          const priorMinor = priorRefunds.reduce(
            (t, r) => t + toMinor(moneyToNumber(r.amount), 'SAR'),
            0,
          );
          // CASH priors only (re-review N1): pre-payment credits moved
          // no cash — counting them against the cash cap would refuse
          // the lawful full unwind (credit + pay + cash refund).
          const priorCashMinor = priorRefunds
            .filter((r) => r.settlementInteraction === 'revenue_reversed')
            .reduce((t, r) => t + toMinor(moneyToNumber(r.amount), 'SAR'), 0);
          // CUMULATIVE CAP: Σ fee refunds never exceeds the original
          // Qift invoice amounts — and each path caps to ITS money.
          if (priorMinor + amountMinor > totalMinor) {
            throw new ConflictException('refund_exceeds_invoice');
          }
          const paid = invoice.status === 'paid';
          if (paid) {
            // POST-PAYMENT: CASH returned can never exceed collected.
            if (priorCashMinor + amountMinor > receivedMinor) {
              throw new ConflictException('refund_exceeds_collected');
            }
          } else {
            // PRE-PAYMENT: credit reduces only the UNPAID portion.
            if (priorMinor + amountMinor > totalMinor - receivedMinor) {
              throw new ConflictException('refund_exceeds_unpaid_balance');
            }
          }
          // §8.3: VAT at the ORIGINAL frozen proportion (half-up,
          // capped at the remaining frozen VAT).
          const priorVatMinor = priorRefunds.reduce(
            (t, r) => t + toMinor(moneyToNumber(r.vatComponent), 'SAR'),
            0,
          );
          // The COMPLETING refund absorbs the VAT remainder (review
          // finding 4): per-part half-up can undershoot by a halala —
          // full reversal must reverse the frozen VAT exactly.
          const vatComponentMinor =
            priorMinor + amountMinor === totalMinor
              ? Math.min(amountMinor, Math.max(0, vatMinor - priorVatMinor))
              : Math.min(
                  totalMinor === 0
                    ? 0
                    : Math.floor(
                        (amountMinor * vatMinor + Math.floor(totalMinor / 2)) /
                          totalMinor,
                      ),
                  Math.max(0, vatMinor - priorVatMinor),
                );
          const vatComponent = fromMinor(vatComponentMinor, 'SAR');
          const netComponent = fromMinor(amountMinor - vatComponentMinor, 'SAR');
          const interaction = paid ? 'revenue_reversed' : 'invoice_reduced';

          const refund = await tx.settlementRefund.create({
            data: {
              invoiceType: 'corporate_invoice',
              invoiceId: invoice.id,
              storeId: null,
              orgId: invoice.orgId,
              campaignId: invoice.campaignId,
              currency: 'SAR',
              amount,
              vatComponent,
              reason,
              evidenceRef,
              refundedAt,
              recordedBy: actorUserId,
              settlementInteraction: interaction,
            },
          });
          // QD — Qift's OWN sequential legal series (RC v4.0), the QC
          // allocation discipline: transactional, gap-free.
          const seriesYear = this.clock.now().getUTCFullYear();
          const seriesKey = `QD-${seriesYear}`;
          const allocated = await tx.$queryRaw<{ lastValue: number }[]>`
            INSERT INTO "NumberSequence" ("seriesKey", "lastValue", "updatedAt")
            VALUES (${seriesKey}, 1, now())
            ON CONFLICT ("seriesKey")
            DO UPDATE SET "lastValue" = "NumberSequence"."lastValue" + 1,
                          "updatedAt" = now()
            RETURNING "lastValue"`;
          const qiftCreditNoteNumber = formatSequentialReference(
            'QD',
            seriesYear,
            allocated[0].lastValue,
          );
          const referenceNumber = await this.mintQn(tx);
          const taxSnapshot = (invoice.taxSnapshot ?? null) as {
            ruleVersion?: string;
          } | null;
          const facts: CreditNoteFacts = {
            referenceNumber,
            refundId: refund.id,
            noteType: 'qift_service_fee',
            invoiceType: 'corporate_invoice',
            invoiceId: invoice.id,
            merchantInvoiceNumber: null,
            merchantCreditNoteNumber: null,
            issuerType: 'QIFT',
            issuanceSource: 'QIFT',
            onBehalfAuthorizationRef: null,
            creditNoteUuid: null,
            originalInvoiceNumber: invoice.invoiceNumber,
            qiftCreditNoteNumber,
            netComponent,
            reasonCode,
            taxRuleVersion: taxSnapshot?.ruleVersion ?? null,
            buyerSnapshot: invoice.buyerSnapshot ?? null,
            issuerSnapshot: invoice.sellerSnapshot ?? null,
            storeId: null,
            orgId: invoice.orgId,
            campaignId: invoice.campaignId,
            currency: 'SAR',
            amount,
            vatComponent,
            reason,
            issuedAt: this.clock.now().toISOString(),
            issuedBy: actorUserId,
            statementSettlementId: null,
          };
          const canonical = creditNoteCanonical(facts);
          const documentHash = creditNoteHash(facts);
          const note = await tx.creditNote.create({
            data: {
              referenceNumber,
              refundId: refund.id,
              noteType: 'qift_service_fee',
              invoiceType: 'corporate_invoice',
              invoiceId: invoice.id,
              merchantInvoiceNumber: null,
              merchantCreditNoteNumber: null,
              qiftCreditNoteNumber,
              issuerType: 'QIFT',
              issuanceSource: 'QIFT',
              onBehalfAuthorizationRef: null,
              creditNoteUuid: null,
              originalInvoiceNumber: invoice.invoiceNumber,
              netComponent,
              reasonCode,
              taxRuleVersion: taxSnapshot?.ruleVersion ?? null,
              buyerSnapshot: invoice.buyerSnapshot ?? undefined,
              issuerSnapshot: invoice.sellerSnapshot ?? undefined,
              currentVersion: 1,
              storeId: null,
              orgId: invoice.orgId,
              campaignId: invoice.campaignId,
              currency: 'SAR',
              amount,
              vatComponent,
              reason,
              issuedAt: new Date(facts.issuedAt),
              issuedBy: actorUserId,
              canonicalJson: canonical,
              documentHash,
            },
          });
          await tx.creditNoteVersion.create({
            data: {
              creditNoteId: note.id,
              versionNumber: 1,
              changeReason: 'issued',
              canonicalJson: canonical,
              documentHash,
              statementSettlementId: null,
              createdBy: actorUserId,
            },
          });

          // ── Ledger (deterministic occurrence keys; compensating
          //    entries only — nothing merchant-facing, ever) ────────
          if (paid) {
            // Cash out of OPERATING (Qift's own money).
            await this.ledger.record(
              {
                eventType: FINANCIAL_EVENTS.REFUND_PAID,
                reasonCode: 'REFUND_FEE',
                actorType: 'user',
                actorId: actorUserId,
                amount,
                currency: 'SAR',
                direction: 'debit',
                counterpartyType: 'company',
                campaignId: invoice.campaignId,
                orgId: invoice.orgId,
                idempotencyKey: ledgerIdempotencyKey(
                  FINANCIAL_EVENTS.REFUND_PAID,
                  refund.id,
                ),
                metadata: {
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.invoiceNumber,
                  creditNoteReference: referenceNumber,
                  qiftCreditNoteNumber,
                  evidenceRef,
                  account: 'operating',
                  reasonCode,
                },
              },
              tx,
            );
            // Compensating REVENUE reversal (net component) against
            // the coverage-time recognition — prior rows untouched.
            if (amountMinor - vatComponentMinor > 0) {
              await this.ledger.record(
                {
                  eventType: FINANCIAL_EVENTS.QIFT_REVENUE_RECOGNIZED,
                  reasonCode: 'QIFT_REVENUE',
                  actorType: 'user',
                  actorId: actorUserId,
                  amount: netComponent,
                  currency: 'SAR',
                  direction: 'debit', // reversal of the recognized credit
                  counterpartyType: 'company',
                  campaignId: invoice.campaignId,
                  orgId: invoice.orgId,
                  idempotencyKey: ledgerIdempotencyKey(
                    FINANCIAL_EVENTS.QIFT_REVENUE_RECOGNIZED,
                    `${invoice.id}:reversal:${refund.id}`,
                  ),
                  metadata: {
                    compensates: ledgerIdempotencyKey(
                      FINANCIAL_EVENTS.QIFT_REVENUE_RECOGNIZED,
                      invoice.id,
                    ),
                    refundId: refund.id,
                    creditNoteReference: referenceNumber,
                    qiftCreditNoteNumber,
                  },
                },
                tx,
              );
            }
          } else {
            // PRE-PAYMENT: the receivable shrinks (no cash).
            await this.ledger.record(
              {
                eventType: FINANCIAL_EVENTS.REFUND_APPROVED,
                reasonCode: 'CORPORATE_RECEIVABLE',
                actorType: 'user',
                actorId: actorUserId,
                amount,
                currency: 'SAR',
                direction: 'debit', // Qift is owed LESS
                counterpartyType: 'company',
                campaignId: invoice.campaignId,
                orgId: invoice.orgId,
                idempotencyKey: ledgerIdempotencyKey(
                  FINANCIAL_EVENTS.REFUND_APPROVED,
                  refund.id,
                ),
                metadata: {
                  invoiceId: invoice.id,
                  invoiceNumber: invoice.invoiceNumber,
                  creditNoteReference: referenceNumber,
                  qiftCreditNoteNumber,
                  evidenceRef,
                  reasonCode,
                  compensates: ledgerIdempotencyKey(
                    FINANCIAL_EVENTS.CORPORATE_INVOICE_ISSUED,
                    invoice.id,
                  ),
                },
              },
              tx,
            );
          }
          // VAT reversal at the frozen proportion — the DOCUMENT is
          // the VAT source of truth (FC 7.6); this row makes the
          // reversal ledger-visible, keyed on the refund occurrence.
          if (vatComponentMinor > 0) {
            await this.ledger.record(
              {
                eventType: FINANCIAL_EVENTS.REFUND_APPROVED,
                reasonCode: 'QIFT_VAT',
                actorType: 'user',
                actorId: actorUserId,
                amount: vatComponent,
                currency: 'SAR',
                direction: 'debit',
                counterpartyType: 'company',
                campaignId: invoice.campaignId,
                orgId: invoice.orgId,
                idempotencyKey: ledgerIdempotencyKey(
                  FINANCIAL_EVENTS.REFUND_APPROVED,
                  `${refund.id}:vat`,
                ),
                metadata: {
                  refundId: refund.id,
                  creditNoteReference: referenceNumber,
                  qiftCreditNoteNumber,
                  taxRuleVersion: taxSnapshot?.ruleVersion ?? null,
                },
              },
              tx,
            );
          }
          return { existing: null, refund, note };
          },
          { isolationLevel: 'Serializable' },
        ),
      );
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        // Concurrent identical submissions (§18.1): resolve by
        // identity via the evidence unique — the receipts pattern.
        const existing = await this.prisma.settlementRefund.findUnique({
          where: {
            invoiceType_invoiceId_evidenceRef: {
              invoiceType: 'corporate_invoice',
              invoiceId: input.invoiceId,
              evidenceRef,
            },
          },
        });
        if (existing) {
          outcome = { existing, refund: null, note: null };
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
    if (outcome.existing) {
      if (
        toMinor(moneyToNumber(outcome.existing.amount), 'SAR') !==
          amountMinor ||
        outcome.existing.refundedAt.getTime() !== refundedAt.getTime()
      ) {
        throw new ConflictException('refund_evidence_conflict');
      }
      if (outcome.existing.settlementInteraction === 'invoice_reduced') {
        // §18.2 heal (re-review N2): a crash between the credit's
        // commit and the derive leaves coverage stale — the natural
        // retry (same evidence) finishes the chain, the receipts
        // pattern.
        await this.receipts.deriveAndApplyCoverage(
          actorUserId,
          'corporate_invoice',
          outcome.existing.invoiceId,
        );
      }
      return { refund: outcome.existing, replayed: true as const };
    }
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'finance.credit_note.issued',
      targetType: 'organization',
      targetId: outcome.refund!.orgId,
      metadata: {
        creditNoteReference: outcome.note!.referenceNumber,
        qiftCreditNoteNumber: outcome.note!.qiftCreditNoteNumber,
        issuerType: 'QIFT',
        refundId: outcome.refund!.id,
        invoiceId: outcome.refund!.invoiceId,
        amount,
        vatComponent: moneyToNumber(outcome.refund!.vatComponent),
      },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'finance.refund.recorded',
      targetType: 'organization',
      targetId: outcome.refund!.orgId,
      metadata: {
        refundId: outcome.refund!.id,
        invoiceType: 'corporate_invoice',
        invoiceId: outcome.refund!.invoiceId,
        amount,
        vatComponent: moneyToNumber(outcome.refund!.vatComponent),
        currency: 'SAR',
        reason,
        reasonCode,
        evidenceRef,
        settlementInteraction: outcome.refund!.settlementInteraction,
      },
    });
    if (outcome.refund!.settlementInteraction === 'invoice_reduced') {
      // The credit may have completed coverage (effective total met or
      // extinguished) — derive it now, idempotently (finding 2).
      await this.receipts.deriveAndApplyCoverage(
        actorUserId,
        'corporate_invoice',
        outcome.refund!.invoiceId,
      );
    }
    return { refund: outcome.refund!, replayed: false as const };
  }

  // The ONE QN mint site (tripwire-pinned): both legs mint here.
  private async mintQn(tx: {
    creditNote: {
      findUnique: (args: {
        where: { referenceNumber: string };
        select: { id: boolean };
      }) => Promise<{ id: string } | null>;
    };
  }) {
    return allocateReference('QN', async (candidate) =>
      Boolean(
        await tx.creditNote.findUnique({
          where: { referenceNumber: candidate },
          select: { id: true },
        }),
      ),
    );
  }

  private async withSerializableRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if ((e as { code?: string })?.code === 'P2034' && attempt < 2) {
          continue;
        }
        throw e;
      }
    }
  }

  private assertGatesOpen() {
    if (process.env[GATES_ENV] !== 'true') {
      throw new ConflictException('financial_gates_not_attested');
    }
  }
}
