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
import { allocateReference } from '../references/reference';
import { SETTLEMENT_CLOCK, type SettlementClock } from './settlement-clock';
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
};

@Injectable()
export class SettlementRefundsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
  ) {}

  async recordRefund(actorUserId: string, input: RecordRefundInput) {
    this.assertGatesOpen();
    if (input.invoiceType === 'corporate_invoice') {
      // §8.1: the fee leg is Qift's OWN money — a different account,
      // a different credit note, a different posting group. It lands
      // with SETTLE-3b; misallocating it into the goods path would
      // spend merchant money on Qift's refund.
      throw new BadRequestException('fee_refund_not_implemented');
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
            const vatComponentMinor = Math.min(
              totalMinor === 0
                ? 0
                : Math.floor(
                    (amountMinor * vatMinor + Math.floor(totalMinor / 2)) /
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
            const referenceNumber = await allocateReference(
              'QN',
              async (candidate) =>
                Boolean(
                  await tx.creditNote.findUnique({
                    where: { referenceNumber: candidate },
                    select: { id: true },
                  }),
                ),
            );
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
            await tx.creditNote.create({
              data: {
                referenceNumber,
                refundId: refund.id,
                noteType: 'merchant_goods',
                invoiceType: 'merchant_invoice',
                invoiceId: invoice.id,
                merchantInvoiceNumber: invoice.merchantInvoiceNumber,
                merchantCreditNoteNumber:
                  input.merchantCreditNoteNumber?.trim() || null,
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
                documentHash: creditNoteHash(facts),
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
                  account: 'safeguarding',
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
    if (invoiceType !== 'merchant_invoice') {
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
      targetType: 'store',
      targetId: note.storeId,
      metadata: {
        creditNoteReference: note.referenceNumber,
        refundId,
        documentVersion: 'v1',
        identical,
      },
    });
    return {
      creditNoteReference: note.referenceNumber,
      documentVersion: 'v1' as const,
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
