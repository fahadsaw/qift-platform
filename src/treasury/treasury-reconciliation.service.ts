// Three-way Treasury Reconciliation service (Lane 2 PR 1).
//
// Constitutional basis: SC §10.3 (daily three-way treasury — required
// from the first collected riyal), §13.3 (account movement law),
// §1 (every riyal enumerable), §24 (forward-only corrections);
// FC Ch. 17.2 (treasury reconciliation), Ch. 5 (reconciliation
// surfaces). Readiness Audit v1.0 gap G1.
//
// HARD BOUNDARIES (founder mandate):
// - READ-ONLY over money: this service NEVER posts to the ledger and
//   NEVER mutates a financial row. Its only writes are its own two
//   append-only treasury tables + audit rows.
// - NO invented bank balance: the bank leg exists only as imported or
//   manually attested evidence. Without an attestation the run is
//   honestly 'pending' with a null bank balance.
// - Every difference is ENUMERATED (per movement / per event type),
//   never netted into a single silent number.
// - Resolution is DOCUMENTATION (notes + evidence reference). Any
//   actual correction travels the constitutional lanes — refunds,
//   receivables, compensating entries (SC §24) — never this surface.
// - NOT gated on QIFT_FINANCIAL_GATES_ATTESTED: reconciliation is
//   measurement, and measurement must be provable BEFORE the first
//   riyal (Evidence Checklist item D3). The gate blocks money
//   movement; this surface moves none.
//
// Clock discipline (RULE 2): time enters only via the injectable
// SETTLEMENT_CLOCK; bank value dates are business facts from
// evidence, never machine time.

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FINANCIAL_EVENTS } from '../financial/financial-events';
import { SETTLEMENT_CLOCK, type SettlementClock } from '../settlement/settlement-clock';
import { toMinor, fromMinor } from '../fees/money';
import { buildTreasurySnapshot } from './treasury-snapshot';
import type { TreasuryMovement } from './treasury-snapshot';
import { TreasuryInternalTransferService } from './treasury-internal-transfer.service';
import { hashCanonical } from '../settlement/settlement-statement';

type MoneyLike = number | { toNumber(): number } | string;
const moneyToNumber = (v: MoneyLike): number =>
  typeof v === 'number'
    ? v
    : typeof v === 'string'
      ? Number(v)
      : v.toNumber();

const SAFEGUARDING = 'safeguarding';

type LedgerRow = {
  id: string;
  eventType: string;
  amount: MoneyLike;
  currency: string;
  direction: string;
  orderId: string | null;
  storeId: string | null;
  createdAt: Date;
  idempotencyKey: string | null;
  metadata: Record<string, unknown> | null;
};

@Injectable()
export class TreasuryReconciliationService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
    // Scope C: the pending-transfer derivation (read-only here).
    private internalTransfers: TreasuryInternalTransferService,
  ) {}

  // ── Bank leg: attestations (append-only evidence) ────────────────

  async recordAttestation(
    actorUserId: string,
    input: {
      balance: number;
      asOfDate: string;
      evidenceRef: string;
      source?: string;
      notes?: string;
    },
  ) {
    if (typeof input.balance !== 'number' || !Number.isFinite(input.balance)) {
      throw new BadRequestException('treasury_balance_invalid');
    }
    const asOfDate = new Date(input.asOfDate);
    if (Number.isNaN(asOfDate.getTime())) {
      throw new BadRequestException('treasury_as_of_invalid');
    }
    const evidenceRef =
      typeof input.evidenceRef === 'string' ? input.evidenceRef.trim() : '';
    if (!evidenceRef) {
      // No invented balance: a number without bank evidence is not an
      // attestation.
      throw new BadRequestException('treasury_evidence_required');
    }
    const source = input.source?.trim() || 'manual_attestation';
    if (source !== 'manual_attestation' && source !== 'statement_import') {
      throw new BadRequestException('treasury_source_unknown');
    }
    const balance = fromMinor(toMinor(input.balance, 'SAR'), 'SAR');
    // Scope A: evidence row + audit are ONE transaction.
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.treasuryAttestation.create({
        data: {
          accountType: SAFEGUARDING,
          currency: 'SAR',
          balance,
          asOfDate,
          source,
          evidenceRef,
          notes: input.notes?.trim() || null,
          recordedBy: actorUserId,
        },
      });
      await this.audit.recordGuaranteed(
        {
          auditKey: `finance.treasury.attested:${created.id}`,
          actorUserId,
          actorType: 'user',
          action: 'finance.treasury.attested',
          targetType: 'system',
          targetId: created.id,
          metadata: {
            attestationId: created.id,
            balance,
            asOfDate: asOfDate.toISOString(),
            source,
            evidenceRef,
          },
        },
        tx,
      );
      return created;
    });
    return row;
  }

  async listAttestations() {
    return this.prisma.treasuryAttestation.findMany({
      orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  // ── The three-way run ────────────────────────────────────────────

  async runReconciliation(
    actorUserId: string,
    input: { asOfDate: string; attestationId?: string },
  ) {
    const asOfDate = new Date(input.asOfDate);
    if (Number.isNaN(asOfDate.getTime())) {
      throw new BadRequestException('treasury_as_of_invalid');
    }
    const asOfIso = asOfDate.toISOString();

    // Bank leg — explicit attestation, or the latest one stated AT
    // this exact value date. NEVER a guess: none found → 'pending'.
    let attestation: {
      id: string;
      balance: MoneyLike;
      asOfDate: Date;
      source: string;
      evidenceRef: string;
    } | null = null;
    if (input.attestationId) {
      const found = await this.prisma.treasuryAttestation.findUnique({
        where: { id: input.attestationId },
      });
      if (!found) throw new NotFoundException('treasury_attestation_not_found');
      if (found.asOfDate.toISOString() !== asOfIso) {
        // A balance is a fact AT a date — reconciling date X against a
        // balance stated at date Y would be an invented number.
        throw new ConflictException('treasury_attestation_date_mismatch');
      }
      attestation = found;
    } else {
      attestation = await this.prisma.treasuryAttestation.findFirst({
        where: { accountType: SAFEGUARDING, asOfDate },
        orderBy: { createdAt: 'desc' },
      });
    }

    const { cashMovements, obligationMovements, excluded } =
      await this.gatherMovements();

    const pendingInternalTransfers =
      await this.internalTransfers.pendingInternalTransfers();
    const built = buildTreasurySnapshot({
      accountType: SAFEGUARDING,
      currency: 'SAR',
      asOfDate: asOfIso,
      timezone: 'UTC',
      pendingInternalTransfers,
      attestation: attestation
        ? {
            id: attestation.id,
            balanceMinor: toMinor(moneyToNumber(attestation.balance), 'SAR'),
            asOfDate: attestation.asOfDate.toISOString(),
            source: attestation.source,
            evidenceRef: attestation.evidenceRef,
          }
        : null,
      cashMovements,
      obligationMovements,
      excluded,
    });

    // Scope A: the run record + its audit are ONE transaction.
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.treasuryReconciliation.create({
      data: {
        accountType: SAFEGUARDING,
        currency: 'SAR',
        asOfDate,
        attestationId: attestation?.id ?? null,
        status: built.status,
        bankBalance: attestation
          ? fromMinor(toMinor(moneyToNumber(attestation.balance), 'SAR'), 'SAR')
          : null,
        ledgerCashBalance: fromMinor(built.ledgerCashMinor, 'SAR'),
        obligationsBalance: fromMinor(built.obligationsMinor, 'SAR'),
        bankVsCashDelta:
          built.bankVsCashMinor === null
            ? null
            : fromMinor(built.bankVsCashMinor, 'SAR'),
        cashVsObligationsDelta: fromMinor(built.cashVsObligationsMinor, 'SAR'),
        differenceCount: built.differences.length,
        canonicalJson: built.canonical,
        snapshotHash: built.hash,
        computedBy: actorUserId,
      },
      });
      await this.audit.recordGuaranteed(
        {
          auditKey: `finance.treasury.reconciled:${created.id}`,
          actorUserId,
          actorType: 'user',
          action: 'finance.treasury.reconciled',
          targetType: 'system',
          targetId: created.id,
          metadata: {
            reconciliationId: created.id,
        asOfDate: asOfIso,
        status: built.status,
        snapshotHash: built.hash,
        differenceCount: built.differences.length,
        bankVsCashMinor: built.bankVsCashMinor,
        cashVsObligationsMinor: built.cashVsObligationsMinor,
      },
        },
        tx,
      );
      return created;
    });
    return this.render(row);
  }

  // Gather every safeguarding-relevant ledger row and resolve its
  // bank VALUE DATE from the evidence row its idempotency key anchors
  // (receipt.receivedAt / remittance.executedAt / refund.refundedAt).
  // Unresolvable rows become enumerated exceptions — never guesses.
  private async gatherMovements(): Promise<{
    cashMovements: TreasuryMovement[];
    obligationMovements: TreasuryMovement[];
    excluded: Array<{ class: string; count: number; amountMinor: number }>;
  }> {
    const rows = (await this.prisma.financialLedgerEntry.findMany({
      where: {
        eventType: {
          in: [
            FINANCIAL_EVENTS.INVOICE_PAYMENT_RECEIVED,
            FINANCIAL_EVENTS.MERCHANT_PAYABLE_ACCRUED,
            FINANCIAL_EVENTS.MERCHANT_REMITTANCE_PAID,
            FINANCIAL_EVENTS.REFUND_PAID,
            FINANCIAL_EVENTS.MERCHANT_RECEIVABLE_RECOVERED,
            FINANCIAL_EVENTS.INTERNAL_TRANSFER_COMPLETED,
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })) as unknown as LedgerRow[];

    const anchorOf = (row: LedgerRow): string | null => {
      if (!row.idempotencyKey) return null;
      const prefix = `${row.eventType}:`;
      return row.idempotencyKey.startsWith(prefix)
        ? row.idempotencyKey.slice(prefix.length)
        : null;
    };

    // Batched evidence lookups.
    const receiptIds: string[] = [];
    const remittanceIds: string[] = [];
    const refundIds: string[] = [];
    const recoverySettlementIds: string[] = [];
    for (const row of rows) {
      const anchor = anchorOf(row);
      if (!anchor) continue;
      switch (row.eventType) {
        case FINANCIAL_EVENTS.INVOICE_PAYMENT_RECEIVED:
        case FINANCIAL_EVENTS.MERCHANT_PAYABLE_ACCRUED:
          if (!row.orderId) receiptIds.push(anchor);
          break;
        case FINANCIAL_EVENTS.MERCHANT_REMITTANCE_PAID:
          remittanceIds.push(anchor);
          break;
        case FINANCIAL_EVENTS.REFUND_PAID:
          refundIds.push(anchor);
          break;
        case FINANCIAL_EVENTS.MERCHANT_RECEIVABLE_RECOVERED: {
          // Anchor is `${receivableId}:${settlementId}` — the draw's
          // value date is that batch's remittance executedAt.
          const idx = anchor.indexOf(':');
          if (idx > 0) recoverySettlementIds.push(anchor.slice(idx + 1));
          break;
        }
      }
    }
    const [receipts, remittances, refunds, recoveryRemits] = await Promise.all([
      receiptIds.length
        ? this.prisma.paymentReceipt.findMany({
            where: { id: { in: receiptIds } },
            select: { id: true, receivedAt: true, bankReference: true },
          })
        : Promise.resolve([]),
      remittanceIds.length
        ? this.prisma.settlementRemittance.findMany({
            where: { id: { in: remittanceIds } },
            select: {
              id: true,
              executedAt: true,
              bankTransferReference: true,
              settlementReference: true,
            },
          })
        : Promise.resolve([]),
      refundIds.length
        ? this.prisma.settlementRefund.findMany({
            where: { id: { in: refundIds } },
            select: { id: true, refundedAt: true, evidenceRef: true },
          })
        : Promise.resolve([]),
      recoverySettlementIds.length
        ? this.prisma.settlementRemittance.findMany({
            where: { settlementId: { in: recoverySettlementIds } },
            select: {
              settlementId: true,
              executedAt: true,
              bankTransferReference: true,
              settlementReference: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const receiptById = new Map(receipts.map((r) => [r.id, r] as const));
    const remitById = new Map(remittances.map((r) => [r.id, r] as const));
    const refundById = new Map(refunds.map((r) => [r.id, r] as const));
    const remitBySettlement = new Map(
      recoveryRemits.map(
        (r) => [r.settlementId, r] as [string, (typeof recoveryRemits)[number]],
      ),
    );

    const cashMovements: TreasuryMovement[] = [];
    const obligationMovements: TreasuryMovement[] = [];
    const excludedCounts = new Map<string, { count: number; amountMinor: number }>();
    const exclude = (cls: string, amountMinor: number) => {
      const cur = excludedCounts.get(cls) ?? { count: 0, amountMinor: 0 };
      cur.count += 1;
      cur.amountMinor += amountMinor;
      excludedCounts.set(cls, cur);
    };

    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const amountMinor = toMinor(moneyToNumber(row.amount), 'SAR');
      const anchor = anchorOf(row);
      const base = {
        ledgerId: row.id,
        eventType: row.eventType,
        amountMinor,
        recordedAt: row.createdAt.toISOString(),
        storeId: row.storeId ?? null,
      };
      switch (row.eventType) {
        case FINANCIAL_EVENTS.INVOICE_PAYMENT_RECEIVED: {
          if (meta.account !== SAFEGUARDING) {
            exclude('operating_account_cash', amountMinor);
            break;
          }
          const ev = anchor ? receiptById.get(anchor) : undefined;
          cashMovements.push({
            ...base,
            direction: 'in',
            valueDate: ev ? ev.receivedAt.toISOString() : null,
            reference: String(meta.invoiceNumber ?? meta.invoiceId ?? row.id),
            evidenceRef: ev?.bankReference ?? String(meta.bankReference ?? ''),
          });
          break;
        }
        case FINANCIAL_EVENTS.MERCHANT_PAYABLE_ACCRUED: {
          if (row.orderId) {
            // Consumer lane (MockGateway — no real cash moves).
            exclude('consumer_lane_payable', amountMinor);
            break;
          }
          const ev = anchor ? receiptById.get(anchor) : undefined;
          obligationMovements.push({
            ...base,
            direction: 'in',
            valueDate: ev ? ev.receivedAt.toISOString() : null,
            reference: String(meta.invoiceNumber ?? meta.invoiceId ?? row.id),
            evidenceRef: ev?.bankReference ?? null,
          });
          break;
        }
        case FINANCIAL_EVENTS.MERCHANT_REMITTANCE_PAID: {
          const ev = anchor ? remitById.get(anchor) : undefined;
          const movement: TreasuryMovement = {
            ...base,
            direction: 'out',
            valueDate: ev ? ev.executedAt.toISOString() : null,
            reference: String(
              meta.settlementReference ?? ev?.settlementReference ?? row.id,
            ),
            evidenceRef:
              ev?.bankTransferReference ??
              String(meta.bankTransferReference ?? ''),
          };
          cashMovements.push(movement);
          obligationMovements.push({ ...movement });
          break;
        }
        case FINANCIAL_EVENTS.REFUND_PAID: {
          if (meta.account !== SAFEGUARDING) {
            // Fee refunds (operating) and post-settlement fronted
            // refunds (operating) never touch safeguarding cash.
            exclude('operating_account_refund', amountMinor);
            break;
          }
          const ev = anchor ? refundById.get(anchor) : undefined;
          const movement: TreasuryMovement = {
            ...base,
            direction: 'out',
            valueDate: ev ? ev.refundedAt.toISOString() : null,
            reference: String(meta.invoiceNumber ?? meta.invoiceId ?? row.id),
            evidenceRef: ev?.evidenceRef ?? String(meta.evidenceRef ?? ''),
          };
          // Client money returned to the payer: cash down AND the
          // matching obligation extinguished — symmetric by law.
          cashMovements.push(movement);
          obligationMovements.push({ ...movement });
          break;
        }
        case FINANCIAL_EVENTS.INTERNAL_TRANSFER_COMPLETED: {
          // Scope C: the evidenced physical sweep — REAL safeguarding
          // cash-out at the bank value date carried in the posting.
          cashMovements.push({
            ...base,
            direction: 'out',
            valueDate:
              typeof meta.valueDate === 'string' ? meta.valueDate : null,
            reference: String(meta.settlementReference ?? row.id),
            evidenceRef: String(meta.bankReference ?? ''),
          });
          break;
        }
        case FINANCIAL_EVENTS.MERCHANT_RECEIVABLE_RECOVERED: {
          if (meta.closureType === 'zero_net_no_transfer') {
            // §26 (Lane 2 PR 2): a statement-only close extinguished
            // this position WITHOUT any bank movement — the posting
            // itself says so (closureType + internalTransferDue, no
            // account claim). Obligations leg only, classified
            // non-cash; value date = the recorded close instant.
            // NEVER an unresolved-evidence mismatch.
            obligationMovements.push({
              ...base,
              direction: 'out',
              valueDate:
                typeof meta.closedAt === 'string' ? meta.closedAt : null,
              reference: String(meta.settlementReference ?? row.id),
              evidenceRef: null, // the Settlement Statement IS the evidence
              nonCash: true,
            });
            break;
          }
          const idx = anchor ? anchor.indexOf(':') : -1;
          const settlementId =
            anchor && idx > 0 ? anchor.slice(idx + 1) : null;
          const ev = settlementId
            ? remitBySettlement.get(settlementId)
            : undefined;
          const movement: TreasuryMovement = {
            ...base,
            direction: 'out',
            valueDate: ev ? ev.executedAt.toISOString() : null,
            reference: String(
              meta.settlementReference ?? ev?.settlementReference ?? row.id,
            ),
            evidenceRef: ev?.bankTransferReference ?? null,
          };
          // §13.3(a): the recovery draw leaves safeguarding for
          // operating AND extinguishes the payable slice it withheld.
          cashMovements.push(movement);
          obligationMovements.push({ ...movement });
          break;
        }
      }
    }

    return {
      cashMovements,
      obligationMovements,
      excluded: [...excludedCounts.entries()].map(([cls, v]) => ({
        class: cls,
        count: v.count,
        amountMinor: v.amountMinor,
      })),
    };
  }

  // ── Reads (integrity-gated) + status transitions ─────────────────

  async listReconciliations(status?: string) {
    const rows = await this.prisma.treasuryReconciliation.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    // Review finding 2: one tampered row must not brick the whole
    // list — ops needs visibility of every other day precisely when
    // an integrity incident is live. Each row carries its own
    // verdict; the single-record read still refuses hard.
    return rows.map((r) => ({
      ...this.render(r),
      integrityOk: hashCanonical(r.canonicalJson) === r.snapshotHash,
    }));
  }

  async getReconciliation(id: string) {
    const row = await this.load(id);
    return this.render(row, { verify: true, includeSnapshot: true });
  }

  async investigate(actorUserId: string, id: string, input: { notes: string }) {
    const row = await this.load(id);
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (!notes) throw new BadRequestException('treasury_notes_required');
    if (row.status !== 'mismatched') {
      throw new ConflictException(
        `treasury_reconciliation_not_investigable:${row.status}`,
      );
    }
    // Scope A: one-shot transition + audit, one transaction.
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.treasuryReconciliation.updateMany({
        where: { id, status: 'mismatched' },
        data: {
          status: 'investigated',
          investigatedBy: actorUserId,
          investigatedAt: this.clock.now(),
          investigationNotes: notes,
        },
      });
      if (moved.count !== 1) {
        throw new ConflictException('treasury_reconciliation_contended');
      }
      await this.audit.recordGuaranteed(
        {
          auditKey: `finance.treasury.investigated:${id}`,
          actorUserId,
          actorType: 'user',
          action: 'finance.treasury.investigated',
          targetType: 'system',
          targetId: id,
          metadata: { reconciliationId: id, notes },
        },
        tx,
      );
    });
    return this.render(await this.load(id));
  }

  async resolve(
    actorUserId: string,
    id: string,
    input: {
      notes: string;
      resolutionKind: string;
      evidenceRef?: string;
      matchedReconciliationId?: string;
    },
  ) {
    const row = await this.load(id);
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (!notes) throw new BadRequestException('treasury_notes_required');
    if (row.status !== 'investigated') {
      // Discipline: a mismatch must be INVESTIGATED before it can be
      // resolved — no straight-to-closed lane.
      throw new ConflictException(
        `treasury_reconciliation_not_resolvable:${row.status}`,
      );
    }
    // Scope D: resolution requires a STRUCTURED basis — a free-text
    // note alone can never close a mismatch.
    const kind = input.resolutionKind?.trim();
    const evidenceRef = input.evidenceRef?.trim() || null;
    let matchedRunId: string | null = null;
    if (kind === 'new_evidence') {
      if (!evidenceRef) {
        throw new BadRequestException('treasury_resolution_evidence_required');
      }
    } else if (kind === 'accepted_timing') {
      if (!evidenceRef) {
        // A dated timing item names the expected clearing evidence.
        throw new BadRequestException('treasury_resolution_evidence_required');
      }
    } else if (kind === 'superseded_by_matched') {
      const matchedId = input.matchedReconciliationId?.trim();
      if (!matchedId) {
        throw new BadRequestException('treasury_resolution_matched_required');
      }
      const matched = await this.prisma.treasuryReconciliation.findUnique({
        where: { id: matchedId },
      });
      if (!matched || matched.status !== 'matched') {
        throw new ConflictException('treasury_resolution_matched_not_matched');
      }
      if (matched.asOfDate.getTime() <= row.asOfDate.getTime()) {
        // Only a LATER matched run can supersede an earlier mismatch.
        throw new ConflictException('treasury_resolution_matched_not_later');
      }
      if (
        matched.accountType !== row.accountType ||
        matched.currency !== row.currency
      ) {
        // Review finding 4: a matched run of a DIFFERENT account or
        // currency proves nothing about this mismatch.
        throw new ConflictException('treasury_resolution_matched_wrong_scope');
      }
      matchedRunId = matched.id;
    } else {
      throw new BadRequestException('treasury_resolution_kind_required');
    }
    // Scope D: attester ≠ resolver — whoever supplied the bank leg of
    // a mismatched run may not also close its investigation.
    if (row.attestationId) {
      const attestation = await this.prisma.treasuryAttestation.findUnique({
        where: { id: row.attestationId },
      });
      if (attestation && attestation.recordedBy === actorUserId) {
        throw new ConflictException('treasury_attester_cannot_resolve');
      }
    }
    // Scope A: one-shot transition + audit, one transaction.
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.treasuryReconciliation.updateMany({
        where: { id, status: 'investigated' },
        data: {
          status: 'resolved',
          resolvedBy: actorUserId,
          resolvedAt: this.clock.now(),
          resolutionNotes: notes,
          resolutionEvidenceRef: evidenceRef,
          resolutionKind: kind,
          resolutionMatchedRunId: matchedRunId,
        },
      });
      if (moved.count !== 1) {
        throw new ConflictException('treasury_reconciliation_contended');
      }
      await this.audit.recordGuaranteed(
        {
          auditKey: `finance.treasury.resolved:${id}`,
          actorUserId,
          actorType: 'user',
          action: 'finance.treasury.resolved',
          targetType: 'system',
          targetId: id,
          metadata: {
            reconciliationId: id,
            notes,
            resolutionKind: kind,
            evidenceRef,
            matchedReconciliationId: matchedRunId,
          },
        },
        tx,
      );
    });
    return this.render(await this.load(id));
  }

  // ── Scope D: treasury health (metrics + enumerated alerts) ───────
  async health() {
    const latest = await this.prisma.treasuryReconciliation.findFirst({
      orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
    });
    const [mismatchedOpen, investigatedOpen] = await Promise.all([
      this.prisma.treasuryReconciliation.count({
        where: { status: 'mismatched' },
      }),
      this.prisma.treasuryReconciliation.count({
        where: { status: 'investigated' },
      }),
    ]);
    const pendingInternalTransfers =
      await this.internalTransfers.pendingInternalTransfers();
    const latestSnapshot = latest
      ? (JSON.parse(latest.canonicalJson) as {
          alerts?: unknown[];
          deltas?: Record<string, unknown>;
        })
      : null;
    return {
      // Reconciliation-zero health metric: the latest run matched and
      // nothing is open — anything else is an alert state.
      reconciliationZero:
        latest?.status === 'matched' &&
        mismatchedOpen === 0 &&
        investigatedOpen === 0,
      latestRun: latest
        ? {
            id: latest.id,
            asOfDate: latest.asOfDate.toISOString(),
            status: latest.status,
            differenceCount: latest.differenceCount,
            snapshotHash: latest.snapshotHash,
            alerts: latestSnapshot?.alerts ?? [],
            deltas: latestSnapshot?.deltas ?? null,
          }
        : null,
      mismatchedOpen,
      investigatedOpen,
      pendingInternalTransfers,
    };
  }

  private async load(id: string) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new BadRequestException('treasury_reconciliation_id_required');
    }
    const row = await this.prisma.treasuryReconciliation.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('treasury_reconciliation_not_found');
    return row;
  }

  // Integrity before rendering (same law as statements): the stored
  // hash must reproduce from the stored canonical bytes.
  private render(
    row: {
      id: string;
      canonicalJson: string;
      snapshotHash: string;
      [k: string]: unknown;
    },
    opts?: { verify?: boolean; includeSnapshot?: boolean },
  ) {
    if (opts?.verify) {
      if (hashCanonical(row.canonicalJson) !== row.snapshotHash) {
        throw new ConflictException('treasury_reconciliation_integrity_violation');
      }
    }
    const { canonicalJson: canonical, ...rest } = row;
    return opts?.includeSnapshot
      ? { ...rest, snapshot: JSON.parse(canonical) as unknown }
      : rest;
  }
}
