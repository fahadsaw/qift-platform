// LedgerReconciliationService (FIN-4) — the safe re-ensure / repair
// surface between the money DOCUMENTS (invoices, paid orders) and the
// money EVENT LOG (FinancialLedgerEntry).
//
// WHY: invoice/order ledger postings are deliberately best-effort — a
// ledger hiccup must never undo an issued invoice or a captured
// payment. That is the right failure posture, but it leaves a gap the
// ledger's own contract calls a money hole: a document can exist with
// no ledger event. Before FIN-4 the only cure was manual SQL. This
// service closes the loop:
//
//   findMissing()  — reconciliation VISIBILITY: which issued invoices /
//                    paid orders have no ledger posting.
//   repair*()      — idempotent BACKFILL from the persisted row (the
//                    document is the source of truth post-issuance) —
//                    NEVER re-derives from live campaign/product state.
//   repairAll()    — findMissing + repair each, returning a report.
//
// SAFETY: every repair posts through FinancialLedgerService.record()
// with the same DETERMINISTIC idempotency key the original producer
// used (`${eventType}:${anchorId}`, financial-events.ts). If the
// original posting exists — or a racing repair lands first — the write
// collides with it and returns the existing row: running repair twice,
// or repairing something that was never broken, cannot double-post.
// Legacy rows without keys are also honored: the missing-check matches
// EITHER the deterministic key OR the pre-FIN-4 correlation
// (campaignId/orderId + reasonCode), so backfill never duplicates a
// key-less entry either (order legs additionally collide on the kept
// @@unique([orderId, reasonCode]) anchor).
//
// PRIVACY: repair metadata carries only ids + a repairedBackfill marker
// — no employee identity, address, phone, or claim data. The ledger's
// recursive sensitive-key stripping applies as defense-in-depth.
//
// SCALE: the missing-scan diffs in memory — correct and simple at pilot
// scale (tens of invoices, hundreds of orders). Revisit with keyset
// pagination when volumes warrant it; the queries are index-backed.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { moneyToNumber } from '../fees/money';
import { buildOrderLedgerEntries } from './order-ledger';
import { FINANCIAL_EVENTS, ledgerIdempotencyKey } from './financial-events';
import { FinancialLedgerService } from './financial-ledger.service';

export type MissingLedgerReport = {
  corporateInvoiceIds: string[];
  merchantInvoiceIds: string[];
  orderIds: string[];
};

export type RepairOutcome = {
  posted: number; // entries actually created by this repair
  alreadyPresent: number; // postings that already existed (no-op)
};

@Injectable()
export class LedgerReconciliationService {
  private readonly logger = new Logger(LedgerReconciliationService.name);

  constructor(
    private prisma: PrismaService,
    private ledger: FinancialLedgerService,
  ) {}

  // ── Visibility ─────────────────────────────────────────────────────

  async findMissing(): Promise<MissingLedgerReport> {
    const [corporateInvoiceIds, merchantInvoiceIds, orderIds] =
      await Promise.all([
        this.missingCorporateInvoicePostings(),
        this.missingMerchantInvoicePostings(),
        this.missingOrderPostings(),
      ]);
    return { corporateInvoiceIds, merchantInvoiceIds, orderIds };
  }

  private async missingCorporateInvoicePostings(): Promise<string[]> {
    const invoices = await this.prisma.corporateInvoice.findMany({
      where: { status: 'issued' },
      select: { id: true, campaignId: true },
    });
    if (invoices.length === 0) return [];
    const entries = await this.prisma.financialLedgerEntry.findMany({
      where: { reasonCode: 'CORPORATE_RECEIVABLE' },
      select: { campaignId: true, idempotencyKey: true },
    });
    const keys = new Set(entries.map((e) => e.idempotencyKey));
    const campaigns = new Set(entries.map((e) => e.campaignId));
    return invoices
      .filter(
        (inv) =>
          !keys.has(
            ledgerIdempotencyKey(
              FINANCIAL_EVENTS.CORPORATE_INVOICE_ISSUED,
              inv.id,
            ),
          ) && !campaigns.has(inv.campaignId), // legacy key-less rows
      )
      .map((inv) => inv.id);
  }

  private async missingMerchantInvoicePostings(): Promise<string[]> {
    const invoices = await this.prisma.merchantInvoice.findMany({
      where: { status: 'issued' },
      select: { id: true, campaignId: true },
    });
    if (invoices.length === 0) return [];
    const entries = await this.prisma.financialLedgerEntry.findMany({
      where: { reasonCode: 'MERCHANT_GOODS_INVOICED' },
      select: { campaignId: true, idempotencyKey: true },
    });
    const keys = new Set(entries.map((e) => e.idempotencyKey));
    const campaigns = new Set(entries.map((e) => e.campaignId));
    return invoices
      .filter(
        (inv) =>
          !keys.has(
            ledgerIdempotencyKey(
              FINANCIAL_EVENTS.MERCHANT_INVOICE_ISSUED,
              inv.id,
            ),
          ) && !campaigns.has(inv.campaignId),
      )
      .map((inv) => inv.id);
  }

  private async missingOrderPostings(): Promise<string[]> {
    // ORDER_PAID is the head entry of the four-leg allocation — if it
    // is missing the order was never posted (per-leg gaps self-heal on
    // repair because every leg carries its own key).
    const orders = await this.prisma.order.findMany({
      where: { status: 'paid' },
      select: { id: true },
    });
    if (orders.length === 0) return [];
    const entries = await this.prisma.financialLedgerEntry.findMany({
      where: { reasonCode: 'ORDER_PAID' },
      select: { orderId: true },
    });
    const posted = new Set(entries.map((e) => e.orderId));
    return orders.filter((o) => !posted.has(o.id)).map((o) => o.id);
  }

  // ── Repair (idempotent backfill) ───────────────────────────────────

  // Re-ensure the company-receivable posting for an ISSUED Qift service
  // invoice, from the persisted invoice row.
  async repairCorporateInvoice(invoiceId: string): Promise<RepairOutcome> {
    const invoice = await this.prisma.corporateInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException('invoice_not_found');

    const key = ledgerIdempotencyKey(
      FINANCIAL_EVENTS.CORPORATE_INVOICE_ISSUED,
      invoice.id,
    );
    if (await this.ledger.findByIdempotencyKey(key)) {
      return { posted: 0, alreadyPresent: 1 };
    }

    await this.ledger.record({
      eventType: FINANCIAL_EVENTS.CORPORATE_INVOICE_ISSUED,
      reasonCode: 'CORPORATE_RECEIVABLE',
      actorType: 'system',
      amount: moneyToNumber(invoice.totalAmount),
      currency: invoice.currency,
      direction: 'credit',
      counterpartyType: 'company',
      campaignId: invoice.campaignId,
      orgId: invoice.orgId,
      idempotencyKey: key,
      metadata: {
        invoiceId: invoice.id,
        recipientCount: invoice.recipientCount,
        repairedBackfill: true,
      },
    });
    this.logger.log(
      `[repair] backfilled CORPORATE_RECEIVABLE for invoice=${invoice.id}`,
    );
    return { posted: 1, alreadyPresent: 0 };
  }

  // Re-ensure the goods posting for an ISSUED merchant invoice, from
  // the persisted invoice row.
  async repairMerchantInvoice(invoiceId: string): Promise<RepairOutcome> {
    const invoice = await this.prisma.merchantInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException('invoice_not_found');

    const key = ledgerIdempotencyKey(
      FINANCIAL_EVENTS.MERCHANT_INVOICE_ISSUED,
      invoice.id,
    );
    if (await this.ledger.findByIdempotencyKey(key)) {
      return { posted: 0, alreadyPresent: 1 };
    }

    await this.ledger.record({
      eventType: FINANCIAL_EVENTS.MERCHANT_INVOICE_ISSUED,
      reasonCode: 'MERCHANT_GOODS_INVOICED',
      actorType: 'system',
      amount: moneyToNumber(invoice.totalAmount),
      currency: invoice.currency,
      direction: 'credit',
      counterpartyType: 'company',
      campaignId: invoice.campaignId,
      orgId: invoice.orgId,
      storeId: invoice.storeId,
      idempotencyKey: key,
      metadata: {
        invoiceId: invoice.id,
        recipientCount: invoice.recipientCount,
        passThrough: true, // merchant's money, never Qift revenue
        repairedBackfill: true,
      },
    });
    this.logger.log(
      `[repair] backfilled MERCHANT_GOODS_INVOICED for invoice=${invoice.id}`,
    );
    return { posted: 1, alreadyPresent: 0 };
  }

  // Re-ensure the four-leg allocation for a PAID order, from the
  // persisted order row. Per-leg idempotency keys (+ the legacy
  // (orderId, reasonCode) anchor) make a partial backfill safe: only
  // the legs that are actually missing get created.
  async repairOrder(orderId: string): Promise<RepairOutcome> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException('order_not_found');
    if (order.status !== 'paid') {
      // Only PAID orders have ledger postings; anything else is a
      // no-op, not an error — safe to sweep broadly.
      return { posted: 0, alreadyPresent: 0 };
    }

    const entries = buildOrderLedgerEntries(order, order.payment?.id ?? null);
    let posted = 0;
    let alreadyPresent = 0;
    for (const entry of entries) {
      const existing = entry.idempotencyKey
        ? await this.ledger.findByIdempotencyKey(entry.idempotencyKey)
        : null;
      if (existing) {
        alreadyPresent += 1;
        continue;
      }
      await this.ledger.record({
        ...entry,
        metadata: { ...(entry.metadata ?? {}), repairedBackfill: true },
      });
      posted += 1;
    }
    if (posted > 0) {
      this.logger.log(
        `[repair] backfilled ${posted} ledger leg(s) for order=${orderId}`,
      );
    }
    return { posted, alreadyPresent };
  }

  // Sweep: find every missing posting and repair it. Idempotent — a
  // second run finds nothing and posts nothing.
  async repairAll(): Promise<{
    missing: MissingLedgerReport;
    posted: number;
  }> {
    const missing = await this.findMissing();
    let posted = 0;
    for (const id of missing.corporateInvoiceIds) {
      posted += (await this.repairCorporateInvoice(id)).posted;
    }
    for (const id of missing.merchantInvoiceIds) {
      posted += (await this.repairMerchantInvoice(id)).posted;
    }
    for (const id of missing.orderIds) {
      posted += (await this.repairOrder(id)).posted;
    }
    return { missing, posted };
  }
}
