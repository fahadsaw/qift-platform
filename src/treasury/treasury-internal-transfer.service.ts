// Internal safeguarding→operating transfer lifecycle (Lane 2 PR 3,
// Scope C). A §26 zero-net close extinguishes merchant positions but
// leaves Qift's own money sitting in the safeguarding account — an
// INTERNAL TRANSFER DUE. This service records the PHYSICAL movement's
// EVIDENCE and nothing else:
//
//   not_required — remitted closes (no due exists);
//   pending      — DERIVED: due postings with no completed evidence
//                  (never a fabricated status row);
//   failed       — an evidenced failed attempt (stays outstanding,
//                  retryable with NEW evidence);
//   completed    — evidenced movement: bank reference, value date,
//                  bank-confirmed amount, executor identity, MASKED
//                  account identifiers, occurrence-keyed posting.
//
// The completed movement posts treasury.internal_transfer.completed
// (a REAL cash event — safeguarding out) so the three-way
// reconciliation's cash view drops exactly when evidence exists,
// never before. No merchant remittance is ever created here.
//
// Separation from the reconciliation service is deliberate: the
// reconciliation surface stays READ-ONLY over money (census-pinned);
// this service is the one treasury writer, and it writes only with
// evidence.

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FinancialLedgerService } from '../financial/financial-ledger.service';
import {
  FINANCIAL_EVENTS,
  ledgerIdempotencyKey,
} from '../financial/financial-events';
import {
  SETTLEMENT_CLOCK,
  type SettlementClock,
} from '../settlement/settlement-clock';
import { toMinor, fromMinor } from '../fees/money';
import { asCurrencyCode } from '../settlement/settlement-calculator';
import type { PendingInternalTransfer } from './treasury-snapshot';

type MoneyLike = number | { toNumber(): number } | string;
const moneyToNumber = (v: MoneyLike): number =>
  typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : v.toNumber();

const DAY_MS = 24 * 60 * 60 * 1000;

// Masked account identifiers ONLY: an optional short scheme prefix,
// four masking stars, and at most four trailing digits. Anything that
// looks like a raw account/IBAN refuses.
const MASKED_RE = /^[A-Za-z]{0,6}\*{4}\d{2,4}$/;

type LedgerRow = {
  id: string;
  eventType: string;
  amount: MoneyLike;
  currency: string;
  idempotencyKey: string | null;
  metadata: Record<string, unknown> | null;
};

@Injectable()
export class TreasuryInternalTransferService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
  ) {}

  // ── The DERIVED pending view (Scope C aging visibility) ──────────
  async pendingInternalTransfers(): Promise<PendingInternalTransfer[]> {
    const { dueBySettlement } = await this.gatherDues();
    const completed = await this.prisma.treasuryInternalTransfer.findMany({
      where: { status: 'completed' },
    });
    const failed = await this.prisma.treasuryInternalTransfer.findMany({
      where: { status: 'failed' },
    });
    const completedBy = new Map(
      completed.map((t) => [t.settlementId, t] as const),
    );
    const failedCount = new Map<string, number>();
    for (const f of failed) {
      failedCount.set(
        f.settlementId,
        (failedCount.get(f.settlementId) ?? 0) + 1,
      );
    }
    const nowMs = this.clock.now().getTime();
    const out: PendingInternalTransfer[] = [];
    for (const [settlementId, due] of [...dueBySettlement.entries()].sort(
      ([x], [y]) => (x < y ? -1 : 1),
    )) {
      if (completedBy.has(settlementId)) continue; // no longer pending
      const closedMs = due.closedAt ? Date.parse(due.closedAt) : nowMs;
      out.push({
        settlementId,
        settlementReference: due.settlementReference,
        currency: due.currency,
        outstandingMinor: due.dueMinor,
        closedAt: due.closedAt,
        ageDays: Math.max(0, Math.floor((nowMs - closedMs) / DAY_MS)),
        failedAttempts: failedCount.get(settlementId) ?? 0,
      });
    }
    return out;
  }

  async listInternalTransfers() {
    return this.prisma.treasuryInternalTransfer.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    });
  }

  // ── Recording evidence (the ONLY write; masked, keyed, audited) ──
  async recordInternalTransfer(
    actorUserId: string,
    input: {
      settlementId: string;
      bankReference: string;
      valueDate: string;
      confirmedAmount: number;
      accountFromMasked: string;
      accountToMasked: string;
      status?: string;
      notes?: string;
    },
  ) {
    const settlementId =
      typeof input.settlementId === 'string' ? input.settlementId.trim() : '';
    if (!settlementId) {
      throw new BadRequestException('internal_transfer_settlement_required');
    }
    const bankReference =
      typeof input.bankReference === 'string' ? input.bankReference.trim() : '';
    if (!bankReference) {
      throw new BadRequestException('internal_transfer_evidence_required');
    }
    const valueDate = new Date(input.valueDate);
    if (Number.isNaN(valueDate.getTime())) {
      throw new BadRequestException('internal_transfer_value_date_invalid');
    }
    if (
      typeof input.confirmedAmount !== 'number' ||
      !Number.isFinite(input.confirmedAmount) ||
      input.confirmedAmount <= 0
    ) {
      throw new BadRequestException('internal_transfer_amount_invalid');
    }
    for (const masked of [input.accountFromMasked, input.accountToMasked]) {
      if (typeof masked !== 'string' || !MASKED_RE.test(masked.trim())) {
        // Raw account identifiers never enter this system.
        throw new BadRequestException('internal_transfer_account_not_masked');
      }
    }
    const status = input.status?.trim() || 'completed';
    if (status !== 'completed' && status !== 'failed') {
      throw new BadRequestException('internal_transfer_status_unknown');
    }

    const { dueBySettlement } = await this.gatherDues();
    const due = dueBySettlement.get(settlementId);
    if (!due || due.dueMinor <= 0) {
      throw new ConflictException('internal_transfer_nothing_outstanding');
    }
    const existing = await this.prisma.treasuryInternalTransfer.findFirst({
      where: { settlementId, status: 'completed' },
    });
    if (existing) {
      throw new ConflictException('internal_transfer_already_completed');
    }
    const confirmedMinor = toMinor(
      input.confirmedAmount,
      asCurrencyCode(due.currency),
    );
    if (status === 'completed' && confirmedMinor !== due.dueMinor) {
      // The bank-confirmed amount must equal the FULL outstanding due
      // exactly — partial sweeps are not a lane.
      throw new ConflictException('internal_transfer_amount_mismatch');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.treasuryInternalTransfer.create({
          data: {
            settlementId,
            settlementReference: due.settlementReference,
            currency: due.currency,
            confirmedAmount: fromMinor(
              confirmedMinor,
              asCurrencyCode(due.currency),
            ),
            bankReference,
            valueDate,
            accountFromMasked: input.accountFromMasked.trim(),
            accountToMasked: input.accountToMasked.trim(),
            status,
            recordedBy: actorUserId,
            notes: input.notes?.trim() || null,
          },
        });
        if (status === 'completed') {
          // The REAL cash event — posted only now, with evidence.
          await this.ledger.record(
            {
              eventType: FINANCIAL_EVENTS.INTERNAL_TRANSFER_COMPLETED,
              reasonCode: 'TREASURY_INTERNAL_TRANSFER',
              actorType: 'user',
              actorId: actorUserId,
              amount: fromMinor(confirmedMinor, 'SAR'),
              currency: due.currency,
              direction: 'debit', // safeguarding cash out
              idempotencyKey: ledgerIdempotencyKey(
                FINANCIAL_EVENTS.INTERNAL_TRANSFER_COMPLETED,
                settlementId,
              ),
              metadata: {
                settlementReference: due.settlementReference,
                bankReference,
                valueDate: valueDate.toISOString(),
                accountFromMasked: input.accountFromMasked.trim(),
                accountToMasked: input.accountToMasked.trim(),
                account: 'safeguarding',
              },
            },
            tx,
          );
        }
        // Scope A: evidence + audit, one transaction.
        await this.audit.recordGuaranteed(
          {
            auditKey: `finance.treasury.internal_transfer.${status}:${row.id}`,
            actorUserId,
            actorType: 'user',
            action: `finance.treasury.internal_transfer.${status}`,
            targetType: 'system',
            targetId: row.id,
            metadata: {
              transferId: row.id,
              settlementId,
              settlementReference: due.settlementReference,
              bankReference,
              valueDate: valueDate.toISOString(),
              confirmedAmount: fromMinor(confirmedMinor, 'SAR'),
              accountFromMasked: input.accountFromMasked.trim(),
              accountToMasked: input.accountToMasked.trim(),
              executedBy: actorUserId,
            },
          },
          tx,
        );
        return row;
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        // Two DB uniques can fire (review finding 3): the
        // bankReference unique (same bank movement claimed twice) or
        // the partial completed-per-settlement unique (a concurrent
        // racer completed first). Distinguish by re-reading.
        const nowCompleted =
          await this.prisma.treasuryInternalTransfer.findFirst({
            where: { settlementId, status: 'completed' },
          });
        if (nowCompleted && nowCompleted.bankReference !== bankReference) {
          throw new ConflictException('internal_transfer_already_completed');
        }
        throw new ConflictException('internal_transfer_evidence_reused');
      }
      throw e;
    }
  }

  // Σ zero-net internal-transfer-due postings per settlement, from
  // the ledger (read-only; the postings are the authority).
  private async gatherDues() {
    const rows = (await this.prisma.financialLedgerEntry.findMany({
      where: {
        eventType: FINANCIAL_EVENTS.MERCHANT_RECEIVABLE_RECOVERED,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })) as unknown as LedgerRow[];
    const dueBySettlement = new Map<
      string,
      {
        settlementReference: string;
        currency: string;
        dueMinor: number;
        closedAt: string | null;
      }
    >();
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      if (meta.closureType !== 'zero_net_no_transfer') continue;
      const key = row.idempotencyKey ?? '';
      const prefix = `${FINANCIAL_EVENTS.MERCHANT_RECEIVABLE_RECOVERED}:`;
      if (!key.startsWith(prefix)) continue;
      const anchor = key.slice(prefix.length);
      const idx = anchor.indexOf(':');
      if (idx <= 0) continue;
      const settlementId = anchor.slice(idx + 1);
      const cur = dueBySettlement.get(settlementId) ?? {
        settlementReference: String(meta.settlementReference ?? settlementId),
        currency: row.currency,
        dueMinor: 0,
        closedAt: typeof meta.closedAt === 'string' ? meta.closedAt : null,
      };
      cur.dueMinor += toMinor(
        moneyToNumber(row.amount),
        asCurrencyCode(row.currency),
      );
      dueBySettlement.set(settlementId, cur);
    }
    return { dueBySettlement };
  }
}
