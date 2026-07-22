// SETTLE-1 receipts (Track C PR 2).
//
// Implements FC Ch. 4.7 (Payment Receipt document) + roadmap SETTLE-1
// and SC v2.0 §5.1 ("cash settles, accruals never"), §13.2 (manual
// rail: bank transfer reference as evidence), §17 (audit), §18.1
// (occurrence-anchored idempotency):
//
//   record receipt (immutable document)
//     → invoice.payment.received:{receiptId}          (cash in, credit)
//     → merchant leg: merchant.payable.accrued:{receiptId} (debit —
//       goods money converts to MERCHANT_PAYABLE as cash lands)
//   coverage (Σ receipts ≥ invoice total) DERIVES `paid`:
//     → status 'paid' + paidAt = completing receipt's value date
//     → fee leg: qift.revenue.recognized:{invoiceId} once, per the
//       RECORDED recognition-policy version (FC 7.6 — VAT posted at
//       issuance, never here)
//     → goods leg: SettlementItem born 'pending' (the §5 evaluator
//       moves it to eligible)
//
// Partial payments are lawful: multiple receipts per invoice (FC 6.2).
// A wrong receipt is corrected by compensating entries — never edited.
//
// RULE 1: every financial computation here stays inside the settlement
// module; controllers only delegate. RULE 2: no direct system time —
// receivedAt is operator-supplied evidence; "now" (aging) comes from
// the injectable SettlementClock.

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
import { SETTLEMENT_CLOCK, type SettlementClock } from './settlement-clock';

// FC 7.6: revenue recognition is an advisor-set, VERSIONED policy.
// Pilot policy v1 recognizes the fee when the fee invoice is fully
// paid (cash basis — conservative; the receivable posted at issuance).
// ⚠️ Advisor confirmation pending (FIN-5 action pack): a confirmed
// different clock becomes a NEW policy version — postings made under
// v1 stand under their recorded version, never restated.
export const REVENUE_RECOGNITION_POLICY = 'on_full_payment@pilot-v1';

// SC §5.7 / FC Ch. 17.4: safeguarding + licensing gates are
// constitutionally prior to the FIRST collection. Until the founder
// records the attestation (deployment config), production receipt
// recording refuses. Tests/local set QIFT_FINANCIAL_GATES_ATTESTED.
const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';

export const INVOICE_TYPES = ['corporate_invoice', 'merchant_invoice'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export type RecordReceiptInput = {
  invoiceType: InvoiceType;
  invoiceId: string;
  amount: number;
  currency?: string;
  bankReference: string;
  receivedAt: string; // ISO date — the bank value date (evidence)
  rail?: string;
};

type InvoiceFacts = {
  id: string;
  status: string;
  totalAmount: number; // major units
  currency: 'SAR';
  orgId: string;
  campaignId: string;
  storeId: string | null;
  platformFeeAmount: number | null; // fee net (corporate only)
  invoiceNumber: string | null; // QC (corporate) / merchant legal number
};

@Injectable()
export class SettlementReceiptsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
  ) {}

  // ── Record a receipt (the only receipt write path) ────────────────
  async recordReceipt(actorUserId: string, input: RecordReceiptInput) {
    this.assertGatesOpen();
    const invoiceType = input.invoiceType;
    if (!INVOICE_TYPES.includes(invoiceType)) {
      throw new BadRequestException('receipt_invoice_type_unknown');
    }
    if (typeof input.invoiceId !== 'string' || !input.invoiceId.trim()) {
      throw new BadRequestException('receipt_invoice_id_required');
    }
    const bankReference =
      typeof input.bankReference === 'string'
        ? input.bankReference.trim()
        : '';
    if (!bankReference) {
      // SC §13.2: the bank's transfer reference IS the evidence.
      throw new BadRequestException('receipt_bank_reference_required');
    }
    const receivedAt = new Date(input.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) {
      throw new BadRequestException('receipt_received_at_invalid');
    }
    const currency = (input.currency ?? 'SAR').toUpperCase();
    if (currency !== 'SAR') {
      // Pilot invoices are SAR documents (schema default; FC Ch. 5.4:
      // amounts in different currencies never mix).
      throw new BadRequestException('receipt_currency_unsupported');
    }
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
      throw new BadRequestException('receipt_amount_must_be_positive');
    }
    const amountMinor = toMinor(input.amount, 'SAR');
    if (amountMinor <= 0) {
      throw new BadRequestException('receipt_amount_must_be_positive');
    }
    const amount = fromMinor(amountMinor, 'SAR');

    let receipt;
    let invoice: InvoiceFacts;
    try {
      // SERIALIZABLE + in-transaction guards (adversarial review
      // finding 1): the status check and the balance re-read run
      // INSIDE the same isolation scope that writes. Two concurrent
      // operators can therefore never both pass the guard — Postgres
      // aborts one with a serialization conflict (P2034), which
      // retries below and then sees the committed sibling receipt.
      // There is no path where Σ receipts exceeds the invoice total.
      const res = await this.withSerializableRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            const inv = await this.loadInvoice(
              invoiceType,
              input.invoiceId,
              tx,
            );
            // §18.1 replay FIRST — before the status and balance
            // guards, which would otherwise double-count the original
            // row and refuse the very retry that heals a crash. A
            // reference that already exists is judged by identity
            // (below), never by balance.
            const existing = await tx.paymentReceipt.findUnique({
              where: {
                invoiceType_invoiceId_bankReference: {
                  invoiceType,
                  invoiceId: inv.id,
                  bankReference,
                },
              },
            });
            if (existing) {
              return { created: null, existing, inv };
            }
            if (inv.status !== 'issued') {
              // paid → balance is zero; draft/cancelled/void → no
              // money is receivable against the document.
              throw new BadRequestException(
                `receipt_invoice_not_receivable:${inv.status}`,
              );
            }
            // Balance guard in integer minor units: Σ receipts + this
            // one may NEVER exceed the invoice total. Over-collection
            // is a real-world event the refund family handles —
            // recording it as a receipt would fabricate a payable /
            // revenue that does not exist.
            const already = await this.receiptTotalMinor(
              invoiceType,
              inv.id,
              tx,
            );
            const totalMinor =
              toMinor(inv.totalAmount, 'SAR') -
              (await this.feeCreditsMinor(invoiceType, inv.id, tx));
            if (already + amountMinor > totalMinor) {
              throw new ConflictException('receipt_exceeds_invoice_balance');
            }
            const created = await tx.paymentReceipt.create({
              data: {
                invoiceType,
                invoiceId: inv.id,
                orgId: inv.orgId,
                campaignId: inv.campaignId,
                storeId: inv.storeId,
                amount,
                currency: 'SAR',
                rail: input.rail ?? 'manual_bank_transfer',
                bankReference,
                receivedAt,
                recordedBy: actorUserId,
              },
            });
            // Cash-in posting, anchored on the receipt occurrence
            // (§11.1/§18.1) — INSIDE the tx: the document and its
            // posting commit atomically.
            await this.ledger.record(
              {
                eventType: FINANCIAL_EVENTS.INVOICE_PAYMENT_RECEIVED,
                reasonCode: 'INVOICE_PAYMENT',
                actorType: 'user',
                actorId: actorUserId,
                amount,
                currency: 'SAR',
                direction: 'credit', // value Qift receives (as agent, for the goods leg)
                campaignId: inv.campaignId,
                orgId: inv.orgId,
                storeId: inv.storeId ?? undefined,
                idempotencyKey: ledgerIdempotencyKey(
                  FINANCIAL_EVENTS.INVOICE_PAYMENT_RECEIVED,
                  created.id,
                ),
                metadata: {
                  invoiceType,
                  invoiceId: inv.id,
                  invoiceNumber: inv.invoiceNumber,
                  bankReference,
                  rail: created.rail,
                  // Direction discipline (SC §13.3): goods →
                  // safeguarding, fee → operating. Recorded,
                  // reconciled daily (§10.3).
                  account:
                    invoiceType === 'merchant_invoice'
                      ? 'safeguarding'
                      : 'operating',
                },
              },
              tx,
            );
            if (invoiceType === 'merchant_invoice') {
              // The goods money converts to MERCHANT_PAYABLE as cash
              // lands (per-receipt — partials accrue exactly what
              // arrived; FC roadmap 308). Debit: value Qift owes.
              await this.ledger.record(
                {
                  eventType: FINANCIAL_EVENTS.MERCHANT_PAYABLE_ACCRUED,
                  reasonCode: 'MERCHANT_PAYABLE',
                  actorType: 'user',
                  actorId: actorUserId,
                  amount,
                  currency: 'SAR',
                  direction: 'debit',
                  counterpartyType: 'merchant',
                  campaignId: inv.campaignId,
                  orgId: inv.orgId,
                  storeId: inv.storeId ?? undefined,
                  idempotencyKey: ledgerIdempotencyKey(
                    FINANCIAL_EVENTS.MERCHANT_PAYABLE_ACCRUED,
                    created.id,
                  ),
                  metadata: {
                    invoiceId: inv.id,
                    invoiceNumber: inv.invoiceNumber,
                    passThrough: true,
                  },
                },
                tx,
              );
            }
            return { created, existing: null, inv };
          },
          { isolationLevel: 'Serializable' },
        ),
      );
      if (res.existing) {
        // §18.1: the same bank transfer recorded twice collides with
        // the original. But "same" means SAME — a DIFFERENT amount or
        // value date under a reused reference is a data-entry error,
        // refused loudly, never swallowed (review finding 4).
        if (
          toMinor(moneyToNumber(res.existing.amount), 'SAR') !== amountMinor ||
          res.existing.receivedAt.getTime() !== receivedAt.getTime()
        ) {
          throw new ConflictException('receipt_reference_conflict');
        }
        // Replay still derives coverage (review finding 3): retrying
        // the SAME receipt is the natural repair for a crash between
        // the receipt commit and the coverage flip.
        const coverage = await this.deriveAndApplyCoverage(
          actorUserId,
          invoiceType,
          input.invoiceId,
        );
        return { receipt: res.existing, replayed: true as const, coverage };
      }
      receipt = res.created!;
      invoice = res.inv;
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        // §18.1: the same bank transfer recorded twice collides with
        // the original. But "same" means SAME — a DIFFERENT amount or
        // value date under a reused reference is a data-entry error,
        // refused loudly, never swallowed (review finding 4).
        const existing = await this.prisma.paymentReceipt.findUnique({
          where: {
            invoiceType_invoiceId_bankReference: {
              invoiceType,
              invoiceId: input.invoiceId,
              bankReference,
            },
          },
        });
        if (existing) {
          if (
            toMinor(moneyToNumber(existing.amount), 'SAR') !== amountMinor ||
            existing.receivedAt.getTime() !== receivedAt.getTime()
          ) {
            throw new ConflictException('receipt_reference_conflict');
          }
          // Replay still derives coverage (review finding 3): retrying
          // the SAME receipt is the natural repair for a crash between
          // the receipt commit and the coverage flip.
          const coverage = await this.deriveAndApplyCoverage(
            actorUserId,
            invoiceType,
            input.invoiceId,
          );
          return { receipt: existing, replayed: true as const, coverage };
        }
      }
      throw e;
    }
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'finance.receipt.recorded',
      targetType: invoiceType === 'merchant_invoice' ? 'store' : 'organization',
      targetId:
        invoiceType === 'merchant_invoice' ? invoice.storeId : invoice.orgId,
      metadata: {
        receiptId: receipt.id,
        invoiceType,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amount,
        currency: 'SAR',
        bankReference,
        rail: receipt.rail,
      },
    });

    // Coverage derivation (its own tx; also re-runnable to heal a
    // concurrent-receipts race — see deriveAndApplyCoverage).
    const coverage = await this.deriveAndApplyCoverage(
      actorUserId,
      invoiceType,
      invoice.id,
    );
    return { receipt, replayed: false as const, coverage };
  }

  // ── Coverage: `paid` DERIVES from receipts covering the total ─────
  // Idempotent and self-healing: safe to call any number of times,
  // from recordReceipt, the eligibility evaluator, or repair flows.
  async deriveAndApplyCoverage(
    actorUserId: string,
    invoiceType: InvoiceType,
    invoiceId: string,
  ) {
    const invoice = await this.loadInvoice(invoiceType, invoiceId);
    const receipts = await this.prisma.paymentReceipt.findMany({
      where: { invoiceType, invoiceId },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    const paidMinor = receipts.reduce(
      (s, r) => s + toMinor(moneyToNumber(r.amount), 'SAR'),
      0,
    );
    const creditsMinor = await this.feeCreditsMinor(invoiceType, invoiceId);
    const totalMinor = toMinor(invoice.totalAmount, 'SAR') - creditsMinor;
    // BOUNDARY 2 (founder refund-integrity): payment and balance are
    // SEPARATE facts. closed_by_payment = receipts reached the
    // effective total (status flips 'paid'); closed_by_credit =
    // credit notes extinguished the balance with the paid amount
    // staying exactly what was received — the invoice is NEVER
    // classified 'paid' by credits.
    const coveredByPayment = receipts.length > 0 && paidMinor >= totalMinor;
    const coveredByCredit =
      !coveredByPayment && totalMinor <= 0 && creditsMinor > 0;
    const covered = coveredByPayment;
    const paymentStatus =
      paidMinor <= 0
        ? 'unpaid'
        : coveredByPayment
          ? 'paid'
          : 'partially_paid';
    const balanceStatus = coveredByPayment
      ? 'closed_by_payment'
      : coveredByCredit
        ? 'closed_by_credit'
        : creditsMinor > 0
          ? 'partially_credited'
          : 'open';
    const result = {
      invoiceType,
      invoiceId,
      totalAmount: fromMinor(totalMinor, 'SAR'),
      creditedAmount: fromMinor(creditsMinor, 'SAR'),
      receiptCount: receipts.length,
      amountReceived: fromMinor(paidMinor, 'SAR'),
      balance: fromMinor(totalMinor - paidMinor, 'SAR'),
      covered,
      paymentStatus,
      balanceStatus,
      status: invoice.status,
    };
    // Balance-status bookkeeping is corporate-only (credits exist only
    // there) and never blocks the money paths.
    if (invoiceType === 'corporate_invoice' && balanceStatus !== 'open') {
      if (coveredByCredit) {
        // Guarded write-once-ish: only an ISSUED (never-paid) invoice
        // can close by credit; paidAt stays NULL — nothing was paid.
        const closed = await this.prisma.corporateInvoice.updateMany({
          where: { id: invoiceId, status: 'issued', balanceStatus: { not: 'closed_by_credit' } },
          data: { balanceStatus: 'closed_by_credit' },
        });
        if (closed.count === 1) {
          await this.audit.record({
            actorUserId,
            actorType: 'user',
            action: 'finance.invoice.closed_by_credit',
            targetType: 'organization',
            targetId: invoice.orgId,
            metadata: {
              invoiceId,
              invoiceNumber: invoice.invoiceNumber,
              creditedAmount: fromMinor(creditsMinor, 'SAR'),
              amountReceived: fromMinor(paidMinor, 'SAR'), // stays as-is
            },
          });
        }
        result.status = invoice.status; // NOT paid
        return result;
      }
      if (balanceStatus === 'partially_credited') {
        await this.prisma.corporateInvoice.updateMany({
          where: { id: invoiceId, balanceStatus: 'open' },
          data: { balanceStatus: 'partially_credited' },
        });
      }
    }
    if (!coveredByPayment || invoice.status === 'paid') {
      // Nothing to flip; still make sure a paid invoice's derived
      // artifacts exist (heals a crash between flip and artifacts).
      if (invoice.status === 'paid') {
        await this.ensureCoverageArtifacts(actorUserId, invoiceType, invoice);
        // Heal (adversarial finding 4): invoices paid BEFORE the
        // balanceStatus column existed defaulted to 'open' — stamp
        // closed_by_payment retroactively, guarded so it runs once.
        if (invoiceType === 'corporate_invoice') {
          await this.prisma.corporateInvoice.updateMany({
            where: { id: invoiceId, status: 'paid', balanceStatus: 'open' },
            data: { balanceStatus: 'closed_by_payment' },
          });
        }
        result.status = 'paid';
        result.balanceStatus = 'closed_by_payment';
      }
      return result;
    }
    // paidAt = the COMPLETING receipt's value date — a business fact
    // from evidence, never a machine clock. Reached only via
    // coveredByPayment, so a receipt always exists (boundary 2:
    // credit-only closure NEVER sets paidAt).
    const paidAt = receipts[receipts.length - 1].receivedAt;
    const flipped =
      invoiceType === 'merchant_invoice'
        ? await this.prisma.merchantInvoice.updateMany({
            where: { id: invoiceId, status: 'issued' },
            data: { status: 'paid', paidAt },
          })
        : await this.prisma.corporateInvoice.updateMany({
            where: { id: invoiceId, status: 'issued' },
            data: {
              status: 'paid',
              paidAt,
              balanceStatus: 'closed_by_payment',
            },
          });
    if (flipped.count === 1) {
      await this.audit.record({
        actorUserId,
        actorType: 'user',
        action: 'finance.invoice.paid',
        targetType:
          invoiceType === 'merchant_invoice' ? 'store' : 'organization',
        targetId:
          invoiceType === 'merchant_invoice' ? invoice.storeId : invoice.orgId,
        metadata: {
          invoiceType,
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          totalAmount: result.totalAmount,
          receiptCount: receipts.length,
          paidAt: paidAt.toISOString(),
        },
      });
    }
    await this.ensureCoverageArtifacts(actorUserId, invoiceType, invoice);
    result.status = 'paid';
    return result;
  }

  // ── Receipts listing (read model) ─────────────────────────────────
  async listReceipts(invoiceType: InvoiceType, invoiceId: string) {
    if (!INVOICE_TYPES.includes(invoiceType)) {
      throw new BadRequestException('receipt_invoice_type_unknown');
    }
    if (typeof invoiceId !== 'string' || !invoiceId.trim()) {
      throw new BadRequestException('receipt_invoice_id_required');
    }
    const invoice = await this.loadInvoice(invoiceType, invoiceId);
    const receipts = await this.prisma.paymentReceipt.findMany({
      where: { invoiceType, invoiceId },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    const paidMinor = receipts.reduce(
      (s, r) => s + toMinor(moneyToNumber(r.amount), 'SAR'),
      0,
    );
    const creditsMinor = await this.feeCreditsMinor(invoiceType, invoiceId);
    const totalMinor = toMinor(invoice.totalAmount, 'SAR') - creditsMinor;
    return {
      invoiceType,
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      totalAmount: fromMinor(totalMinor, 'SAR'), // EFFECTIVE (credits netted)
      creditedAmount: fromMinor(creditsMinor, 'SAR'),
      amountReceived: fromMinor(paidMinor, 'SAR'),
      balance: fromMinor(totalMinor - paidMinor, 'SAR'),
      receipts,
    };
  }

  // ── Receivables aging (SC §10.2 read model — recomputed, never
  //    stored truth) ──────────────────────────────────────────────────
  async receivablesAging() {
    const now = this.clock.now().getTime();
    const [corporate, merchant] = await Promise.all([
      this.prisma.corporateInvoice.findMany({
        where: { status: 'issued' },
        orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.merchantInvoice.findMany({
        where: { status: 'issued' },
        orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const rows = [
      ...corporate.map((i) => ({ invoiceType: 'corporate_invoice' as const, i })),
      ...merchant.map((i) => ({ invoiceType: 'merchant_invoice' as const, i })),
    ];
    const out: Array<{
      invoiceType: InvoiceType;
      invoiceId: string;
      invoiceNumber: string | null;
      orgId: string;
      campaignId: string;
      storeId: string | null;
      dueDate: string | null;
      totalAmount: number;
      creditedAmount: number;
      amountReceived: number;
      balance: number;
      daysOverdue: number;
      bucket: string;
    }> = [];
    for (const { invoiceType, i } of rows) {
      const paidMinor = await this.receiptTotalMinor(invoiceType, i.id);
      const creditsMinor = await this.feeCreditsMinor(invoiceType, i.id);
      const totalMinor =
        toMinor(moneyToNumber(i.totalAmount), 'SAR') - creditsMinor;
      const balanceMinor = totalMinor - paidMinor;
      if (balanceMinor <= 0) continue; // fully covered, flip pending — not aged
      const dueDate = (i as { dueDate: Date | null }).dueDate;
      const daysOverdue = dueDate
        ? Math.max(
            0,
            Math.floor((now - dueDate.getTime()) / (24 * 60 * 60 * 1000)),
          )
        : 0;
      out.push({
        invoiceType,
        invoiceId: i.id,
        invoiceNumber:
          invoiceType === 'corporate_invoice'
            ? (i as { invoiceNumber: string }).invoiceNumber
            : ((i as { merchantInvoiceNumber: string | null })
                .merchantInvoiceNumber ?? null),
        orgId: i.orgId,
        campaignId: i.campaignId,
        storeId: (i as { storeId?: string }).storeId ?? null,
        dueDate: dueDate ? dueDate.toISOString() : null,
        totalAmount: fromMinor(totalMinor, 'SAR'), // EFFECTIVE
        creditedAmount: fromMinor(creditsMinor, 'SAR'),
        amountReceived: fromMinor(paidMinor, 'SAR'),
        balance: fromMinor(balanceMinor, 'SAR'),
        daysOverdue,
        bucket:
          daysOverdue <= 0
            ? 'current'
            : daysOverdue <= 30
              ? '1-30'
              : daysOverdue <= 60
                ? '31-60'
                : daysOverdue <= 90
                  ? '61-90'
                  : '90+',
      });
    }
    return { asOf: this.clock.now().toISOString(), items: out };
  }

  // ── internals ─────────────────────────────────────────────────────

  // Coverage artifacts, idempotent by construction:
  //   fee leg  → qift.revenue.recognized:{invoiceId} (deterministic
  //              key collides on replay)
  //   goods leg→ SettlementItem 'pending' (@@unique occurrence)
  private async ensureCoverageArtifacts(
    actorUserId: string,
    invoiceType: InvoiceType,
    invoice: InvoiceFacts,
  ) {
    if (invoiceType === 'corporate_invoice') {
      // Revenue = the fee NET of VAT (VAT-payable posted at issuance —
      // FC 7.6), REDUCED by any pre-payment credit notes' net
      // components (SETTLE-3c-1 review finding 1): a credited fee was
      // never earned — recognizing the full original fee would
      // permanently overstate Qift revenue.
      const credits = await this.prisma.settlementRefund.findMany({
        where: {
          invoiceType: 'corporate_invoice',
          invoiceId: invoice.id,
          settlementInteraction: 'invoice_reduced',
        },
        select: { amount: true, vatComponent: true },
      });
      const creditedNetMinor = credits.reduce(
        (t, r) =>
          t +
          toMinor(moneyToNumber(r.amount), 'SAR') -
          toMinor(moneyToNumber(r.vatComponent), 'SAR'),
        0,
      );
      const feeNet = fromMinor(
        Math.max(
          0,
          toMinor(invoice.platformFeeAmount ?? 0, 'SAR') - creditedNetMinor,
        ),
        'SAR',
      );
      if (feeNet > 0) {
        await this.ledger.record({
          eventType: FINANCIAL_EVENTS.QIFT_REVENUE_RECOGNIZED,
          reasonCode: 'QIFT_REVENUE',
          actorType: 'user',
          actorId: actorUserId,
          amount: feeNet,
          currency: 'SAR',
          direction: 'credit',
          counterpartyType: 'company',
          campaignId: invoice.campaignId,
          orgId: invoice.orgId,
          idempotencyKey: ledgerIdempotencyKey(
            FINANCIAL_EVENTS.QIFT_REVENUE_RECOGNIZED,
            invoice.id,
          ),
          metadata: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            recognitionPolicy: REVENUE_RECOGNITION_POLICY,
          },
        });
      }
      return;
    }
    // Goods leg: the settlement item is born PENDING — §5 eligibility
    // is the evaluator's decision, never implied by payment alone.
    if (!invoice.storeId) return;
    try {
      const item = await this.prisma.settlementItem.create({
        data: {
          occurrenceType: 'merchant_invoice',
          occurrenceId: invoice.id,
          storeId: invoice.storeId,
          currency: 'SAR',
          amount: invoice.totalAmount,
          state: 'pending',
        },
      });
      await this.audit.record({
        actorUserId,
        actorType: 'user',
        action: 'settlement.item.created',
        targetType: 'store',
        targetId: invoice.storeId,
        metadata: {
          settlementItemId: item.id,
          occurrenceType: 'merchant_invoice',
          occurrenceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          amount: invoice.totalAmount,
          state: 'pending',
        },
      });
    } catch (e) {
      // @@unique(occurrenceType, occurrenceId): already born — the
      // idempotency law (§18.1), not an error.
      if ((e as { code?: string })?.code !== 'P2002') throw e;
    }
  }

  // Bounded retry for Postgres serialization conflicts (P2034) under
  // the Serializable receipt transaction — the loser of a concurrent
  // write re-runs its guards against the committed world.
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

  // Pre-payment fee CREDIT NOTES (SETTLE-3c-1) reduce what the org
  // owes on a Qift invoice: the invoice's EFFECTIVE total = frozen
  // total − Σ 'invoice_reduced' fee refunds. Merchant invoices are
  // untouched (goods credits interact through settlement items).
  private async feeCreditsMinor(
    invoiceType: InvoiceType,
    invoiceId: string,
    db: Pick<PrismaService, 'settlementRefund'> = this.prisma,
  ) {
    if (invoiceType !== 'corporate_invoice') return 0;
    const credits = await db.settlementRefund.findMany({
      where: {
        invoiceType: 'corporate_invoice',
        invoiceId,
        settlementInteraction: 'invoice_reduced',
      },
      select: { amount: true },
    });
    return credits.reduce(
      (t, r) => t + toMinor(moneyToNumber(r.amount), 'SAR'),
      0,
    );
  }

  private async receiptTotalMinor(
    invoiceType: InvoiceType,
    invoiceId: string,
    db: Pick<PrismaService, 'paymentReceipt'> = this.prisma,
  ) {
    const receipts = await db.paymentReceipt.findMany({
      where: { invoiceType, invoiceId },
      select: { amount: true },
    });
    return receipts.reduce(
      (s, r) => s + toMinor(moneyToNumber(r.amount), 'SAR'),
      0,
    );
  }

  private async loadInvoice(
    invoiceType: InvoiceType,
    invoiceId: string,
    db: Pick<
      PrismaService,
      'corporateInvoice' | 'merchantInvoice'
    > = this.prisma,
  ): Promise<InvoiceFacts> {
    if (invoiceType === 'merchant_invoice') {
      const inv = await db.merchantInvoice.findUnique({
        where: { id: invoiceId },
      });
      if (!inv) throw new NotFoundException('invoice_not_found');
      this.assertSar(inv.currency);
      return {
        id: inv.id,
        status: inv.status,
        totalAmount: moneyToNumber(inv.totalAmount),
        currency: 'SAR',
        orgId: inv.orgId,
        campaignId: inv.campaignId,
        storeId: inv.storeId,
        platformFeeAmount: null,
        invoiceNumber: inv.merchantInvoiceNumber,
      };
    }
    const inv = await db.corporateInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!inv) throw new NotFoundException('invoice_not_found');
    this.assertSar(inv.currency);
    return {
      id: inv.id,
      status: inv.status,
      totalAmount: moneyToNumber(inv.totalAmount),
      currency: 'SAR',
      orgId: inv.orgId,
      campaignId: inv.campaignId,
      storeId: null,
      platformFeeAmount: moneyToNumber(inv.platformFeeAmount),
      invoiceNumber: inv.invoiceNumber,
    };
  }

  private assertSar(currency: string) {
    // Pilot receipts settle SAR documents only (FC Ch. 5.4 — widening
    // is a registry + storage decision, never an implicit cast).
    if (currency !== 'SAR') {
      throw new BadRequestException('receipt_invoice_currency_unsupported');
    }
  }

  private assertGatesOpen() {
    // SC §5.7 hard gate: safeguarding live + licensing review recorded
    // BEFORE the first collection. The attestation is deployment
    // config the founder flips when Ch. 17.4 is done (action pack).
    if (process.env[GATES_ENV] !== 'true') {
      throw new ConflictException('financial_gates_not_attested');
    }
  }
}
