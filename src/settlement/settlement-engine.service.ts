// Settlement Engine Foundation (Track C PR 1).
//
// Implements Settlement Constitution v2.0:
//   §2  two-grain lifecycle via the state law (settlement-states.ts);
//   §4  the ONE calculator (settlement-calculator.ts) for BOTH
//       simulation and assembly (§30.3 — divergence is a P0 defect);
//   §6  holds are typed + evidenced — a supersession that parks items
//       on hold REQUIRES the type and evidence, never a bare 'held';
//   §14 QS discipline: allocated ONCE at assembly through the single
//       generator; immutable across retries; a re-assembled
//       composition is a NEW batch + NEW QS; SIMULATIONS GET NONE;
//   §11 lifecycle markers on the single ledger write path with
//       deterministic keys (zero-amount marker family), posted INSIDE
//       the same transaction as the state change they record — the
//       §18.2 superseded/crashed distinction depends on atomicity;
//   §18 idempotency + concurrency: item binding is guarded
//       (state='eligible' AND batchId=null in the WHERE) and count-
//       checked inside the transaction, so two concurrent assemblies
//       cannot double-claim money — the loser rolls back;
//   §30 simulation is SIDE-EFFECT-FREE: no documents, no events, no
//       state transitions, no QS — a COUNTS-ONLY audit line is the
//       only permitted trace (§30.2: who, what scope, when);
//   §34 replay: the batch row freezes composition + calculation at
//       assembly; nothing here ever rewrites them.
//
// NOT here (later PRs, per the charter's one-PR law): eligibility
// evaluation (§5), hold placement/release surfaces (§6), reserves
// (§7), receipts/markPaid (SETTLE-1), execution/remittance/statements
// (SETTLE-2), approvals enforcement (§31–§33 — the engine records the
// batch facts those laws bind to; approval surfaces arrive with
// execution).

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
import { allocateReference } from '../references/reference';
import { moneyToNumber } from '../fees/money';
import {
  calculateSettlement,
  type SettlementCalculation,
  type SettlementItemInput,
} from './settlement-calculator';
import {
  assertBatchTransition,
  assertItemTransition,
  type BatchState,
  type ItemState,
} from './settlement-states';
import { SETTLEMENT_CLOCK, type SettlementClock } from './settlement-clock';

// SC §2 Superseded row: items return per cause. Closed set — a new
// cause is a constitutional read, not a convenience.
const SUPERSEDE_ITEM_DISPOSITION: Record<string, ItemState> = {
  composition_drift: 'eligible', // §33.3 drift → re-enter next window
  hold_landed: 'held', // REQUIRES holdType + holdEvidence (§6.1)
  dispute_landed: 'disputed',
  withdrawn: 'eligible',
};

// SC §6.1 typed holds — the closed vocabulary.
const HOLD_TYPES: ReadonlySet<string> = new Set([
  'risk_review',
  'verification_pending',
  'dispute_adjacent',
  'regulatory',
  'manual',
]);

const MAX_ASSEMBLE_ATTEMPTS = 3;

export type SupersedeHold = { holdType: string; holdEvidence: string };

@Injectable()
export class SettlementEngineService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
    // Rule 2 (permanent): time reaches the engine ONLY through this
    // injectable clock — direct system-time reads are pinned out.
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
  ) {}

  // ── §30 Simulation — the same calculator, ZERO side effects ───────
  async simulate(actorUserId: string, storeId: string, currency = 'SAR') {
    const items = await this.eligibleItems(storeId, currency);
    if (items.length === 0) {
      return {
        simulation: true as const,
        snapshotAt: this.clock.now().toISOString(),
        storeId,
        currency: currency.toUpperCase(),
        itemCount: 0,
        calculation: null,
      };
    }
    const calculation = calculateSettlement(items.map(toCalculatorInput));
    // §30.2: a COUNTS-ONLY audit line (who, what scope, when) is the
    // ONLY permitted trace — no computed results in the record.
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.simulated',
      targetType: 'store',
      targetId: storeId,
      metadata: { itemCount: items.length, currency: calculation.currency },
    });
    return {
      // Labeled SIMULATION; carries NO QS and no reference-shaped
      // placeholder (RC App. E), only the ledger-snapshot timestamp
      // (§30.6 staleness law). snapshotAt is a recorded fact, not a
      // calculation input — §34.4 binds calculation paths only.
      simulation: true as const,
      snapshotAt: this.clock.now().toISOString(),
      storeId,
      currency: calculation.currency,
      itemCount: items.length,
      calculation,
    };
  }

  // ── Assembly — QS born here, and only here (§14.1) ────────────────
  async assembleBatch(actorUserId: string, storeId: string, currency = 'SAR') {
    const items = await this.eligibleItems(storeId, currency);
    if (items.length === 0) {
      throw new BadRequestException('settlement_nothing_eligible');
    }
    const calculation = calculateSettlement(items.map(toCalculatorInput));

    // §34: freeze composition + calculation AT assembly. These JSON
    // snapshots are the replay inputs — never rewritten afterward.
    // Canonical references are DENORMALIZED here (SC §15.1: the
    // statement carries each occurrence's references and document
    // numbers; RC Ch. 14.4: purge-survivable, no live joins later).
    const references = await this.occurrenceReferences(items);
    const composition = items.map((i) => ({
      itemId: i.id,
      occurrenceType: i.occurrenceType,
      occurrenceId: i.occurrenceId,
      amount: moneyToNumber(i.amount),
      currency: i.currency,
      references: references.get(`${i.occurrenceType}:${i.occurrenceId}`) ?? {},
    }));

    for (const item of items) {
      assertItemTransition(item.state as ItemState, 'ready');
    }

    // RC Ch. 13.2: P2002 on the QS unique = one bounded fresh-candidate
    // retry, mirroring every sibling allocator.
    for (let attempt = 0; ; attempt++) {
      const settlementReference = await allocateReference(
        'QS',
        async (candidate) =>
          Boolean(
            await this.prisma.settlementBatch.findUnique({
              where: { settlementReference: candidate },
              select: { id: true },
            }),
          ),
      );
      try {
        const batch = await this.prisma.$transaction(async (tx) => {
          const created = await tx.settlementBatch.create({
            data: {
              settlementReference,
              storeId,
              currency: calculation.currency,
              status: 'ready' satisfies BatchState,
              windowType: 'manual',
              grossAmount: calculation.lines.merchantGross,
              netAmount: calculation.netAmount,
              composition,
              calculationSnapshot: calculation,
              // The PROPOSER (§31.1) — create-time frozen fact; the
              // §33 separation checks bind to it.
              assembledBy: actorUserId,
            },
          });
          // CONCURRENCY GUARD (§18.1): bind ONLY items still eligible
          // and unbound — a racing assembly that claimed any of them
          // makes the count fall short, and this whole transaction
          // (batch row included) rolls back. Money cannot be claimed
          // twice.
          const bound = await tx.settlementItem.updateMany({
            where: {
              id: { in: items.map((i) => i.id) },
              state: 'eligible',
              batchId: null,
            },
            data: { state: 'ready' satisfies ItemState, batchId: created.id },
          });
          if (bound.count !== items.length) {
            throw new ConflictException('settlement_items_contended');
          }
          // §11.1 lifecycle marker INSIDE the transaction: the batch
          // and its started event commit atomically (deterministic
          // key makes any replay collide, never duplicate).
          await this.ledger.record(
            {
              eventType: FINANCIAL_EVENTS.SETTLEMENT_STARTED,
              reasonCode: 'SETTLEMENT_STARTED',
              actorType: 'user',
              actorId: actorUserId,
              amount: 0,
              currency: calculation.currency,
              direction: 'debit',
              storeId,
              idempotencyKey: ledgerIdempotencyKey(
                FINANCIAL_EVENTS.SETTLEMENT_STARTED,
                created.id,
              ),
              metadata: {
                settlementReference,
                itemCount: items.length,
                netAmount: calculation.netAmount,
              },
            },
            tx,
          );
          return created;
        });

        await this.audit.record({
          actorUserId,
          actorType: 'user',
          action: 'settlement.batch.assembled',
          targetType: 'store',
          targetId: storeId,
          metadata: {
            settlementId: batch.id,
            settlementReference,
            itemCount: items.length,
            grossAmount: calculation.lines.merchantGross,
            netAmount: calculation.netAmount,
            currency: calculation.currency,
          },
        });
        return batch;
      } catch (e) {
        // Fresh QS candidate ONLY for a reference collision; item
        // contention and everything else propagate.
        const code = (e as { code?: string })?.code;
        if (code === 'P2002' && attempt < MAX_ASSEMBLE_ATTEMPTS - 1) continue;
        throw e;
      }
    }
  }

  // ── Failure lane (§2 Failed row: retry | held | superseded) ──────
  async markFailed(actorUserId: string, batchId: string, evidence: string) {
    const batch = await this.loadBatch(batchId);
    assertBatchTransition(batch.status as BatchState, 'failed');
    if (!evidence?.trim()) {
      throw new BadRequestException('failure_evidence_required');
    }
    const updated = await this.prisma.settlementBatch.update({
      where: { id: batchId },
      data: { status: 'failed', failureEvidence: evidence.trim() },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.batch.failed',
      targetType: 'store',
      targetId: batch.storeId,
      metadata: {
        settlementId: batchId,
        settlementReference: batch.settlementReference,
        evidence: evidence.trim(),
      },
    });
    return updated;
  }

  async retry(actorUserId: string, batchId: string) {
    // Failed|Held → Ready under the SAME QS and the same frozen
    // composition (§14.1: retry keeps it; §25.3). If composition must
    // change, that is supersession, not retry.
    const batch = await this.loadBatch(batchId);
    assertBatchTransition(batch.status as BatchState, 'ready');
    const updated = await this.prisma.settlementBatch.update({
      where: { id: batchId },
      data: { status: 'ready' },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.batch.retried',
      targetType: 'store',
      targetId: batch.storeId,
      metadata: {
        settlementId: batchId,
        settlementReference: batch.settlementReference,
      },
    });
    return updated;
  }

  // §2/§19.2: repeated failure → held + investigation.
  async holdBatch(actorUserId: string, batchId: string, evidence: string) {
    const batch = await this.loadBatch(batchId);
    assertBatchTransition(batch.status as BatchState, 'held');
    if (!evidence?.trim()) {
      throw new BadRequestException('hold_evidence_required');
    }
    const updated = await this.prisma.settlementBatch.update({
      where: { id: batchId },
      data: { status: 'held' },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.batch.held',
      targetType: 'store',
      targetId: batch.storeId,
      metadata: {
        settlementId: batchId,
        settlementReference: batch.settlementReference,
        evidence: evidence.trim(),
      },
    });
    return updated;
  }

  // ── Supersession (v2.0 §2 — the S21 fix, executable) ─────────────
  async supersede(
    actorUserId: string,
    batchId: string,
    cause: string,
    affectedItemIds: string[] = [],
    hold?: SupersedeHold,
  ) {
    const disposition = SUPERSEDE_ITEM_DISPOSITION[cause];
    if (!disposition) {
      throw new BadRequestException('supersede_cause_unknown');
    }
    // §6.1: parking items on hold is typed + evidenced, always.
    if (disposition === 'held') {
      if (
        !hold ||
        !HOLD_TYPES.has(hold.holdType) ||
        !hold.holdEvidence?.trim()
      ) {
        throw new BadRequestException('hold_type_and_evidence_required');
      }
    }
    const batch = await this.loadBatch(batchId);
    assertBatchTransition(batch.status as BatchState, 'superseded');
    // ANTI-DOUBLE-PAY (adversarial review, PR 3): a batch with a
    // recorded bank movement may NEVER be superseded — its items
    // would return to circulation and be paid a second time. A wrong
    // remittance is the §2 Reversed / §18.3 incident lane, not
    // supersession. (The remittance row is created atomically with
    // settled status, so a ready batch with a remittance cannot
    // exist — this check still stands as the recorded law.)
    const remitted = await this.prisma.settlementRemittance.findUnique({
      where: { settlementId: batchId },
      select: { id: true },
    });
    if (remitted) {
      throw new ConflictException('supersede_refused_remittance_exists');
    }

    const items = await this.prisma.settlementItem.findMany({
      where: { batchId },
      select: { id: true, state: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // Unknown affected ids are refused — a typo must not silently send
    // an item meant for hold back into circulation.
    const memberIds = new Set(items.map((i) => i.id));
    for (const id of affectedItemIds) {
      if (!memberIds.has(id)) {
        throw new BadRequestException('supersede_item_not_in_batch');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.settlementBatch.update({
        where: { id: batchId },
        data: { status: 'superseded' },
      });
      const affected = new Set(affectedItemIds);
      for (const item of items) {
        const to: ItemState = affected.has(item.id) ? disposition : 'eligible';
        assertItemTransition(item.state as ItemState, to);
        // Guarded per-item update: the item must still be bound to
        // THIS batch in its read state — contention rolls back.
        const res = await tx.settlementItem.updateMany({
          where: { id: item.id, batchId, state: item.state },
          data: {
            state: to,
            batchId: null,
            ...(affected.has(item.id) && disposition === 'held'
              ? {
                  holdType: hold!.holdType,
                  holdEvidence: hold!.holdEvidence.trim(),
                }
              : {}),
          },
        });
        if (res.count !== 1) {
          throw new ConflictException('settlement_items_contended');
        }
      }
      // §11.1/§18.2: the superseded marker commits ATOMICALLY with the
      // disposition — it is the frozen record that tells the sweep
      // "lawfully abandoned", never "crashed mid-run".
      await this.ledger.record(
        {
          eventType: FINANCIAL_EVENTS.SETTLEMENT_SUPERSEDED,
          reasonCode: 'SETTLEMENT_SUPERSEDED',
          actorType: 'user',
          actorId: actorUserId,
          amount: 0,
          currency: batch.currency,
          direction: 'debit',
          storeId: batch.storeId,
          idempotencyKey: ledgerIdempotencyKey(
            FINANCIAL_EVENTS.SETTLEMENT_SUPERSEDED,
            batch.id,
          ),
          metadata: { settlementReference: batch.settlementReference, cause },
        },
        tx,
      );
    });

    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.batch.superseded',
      targetType: 'store',
      targetId: batch.storeId,
      metadata: {
        settlementId: batchId,
        settlementReference: batch.settlementReference,
        cause,
        affectedItemIds,
        ...(hold ? { holdType: hold.holdType } : {}),
      },
    });
    return this.loadBatch(batchId);
  }

  // ── Settled (SETTLE-2, §13.2 / §11.1) ────────────────────────────
  // Ready → Settled + the REMITTANCE ROW + the settlement.completed
  // marker, ALL in one transaction — the only lawful close of a
  // started batch besides supersession (SC §2). The atomicity is the
  // anti-double-pay law: a SettlementRemittance row can exist ONLY
  // for a batch that actually settled (a concurrent supersession
  // makes the guarded status update fail, rolling the remittance
  // back), and a settled batch can never re-enter circulation.
  // The remittance amount is the batch's FROZEN net — never supplied
  // (RULE 6). Idempotent: an already-settled batch returns its
  // recorded remittance (evidence identity re-checked by the caller).
  async markSettled(
    actorUserId: string,
    batchId: string,
    evidence: {
      bankTransferReference: string;
      executedAt: Date;
      executedBy: string;
    },
  ) {
    const batch = await this.loadBatch(batchId);
    if (batch.status === 'settled') {
      // Idempotent re-run: the recorded movement stands.
      const remittance = await this.prisma.settlementRemittance.findUnique({
        where: { settlementId: batchId },
      });
      if (!remittance) {
        // Settled without a remittance cannot exist under this
        // atomicity — if seen, it is a §18.3 incident for repair.
        throw new ConflictException('settled_without_remittance');
      }
      return { batch, remittance, replayed: true as const };
    }
    assertBatchTransition(batch.status as BatchState, 'settled');
    const memberIds = (
      batch.composition as Array<{ itemId: string }>
    ).map((c) => c.itemId);
    const remittance = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.settlementBatch.updateMany({
        where: { id: batchId, status: 'ready' },
        data: { status: 'settled' },
      });
      if (closed.count !== 1) {
        throw new ConflictException('settlement_batch_contended');
      }
      assertItemTransition('ready', 'settled'); // state law consulted, always
      const settledItems = await tx.settlementItem.updateMany({
        where: { id: { in: memberIds }, batchId, state: 'ready' },
        data: { state: 'settled' satisfies ItemState },
      });
      if (settledItems.count !== memberIds.length) {
        // Drift the execution service should have refused (§33.3) —
        // roll everything back rather than settle a changed batch.
        throw new ConflictException('settlement_items_contended');
      }
      const created = await tx.settlementRemittance.create({
        data: {
          settlementId: batch.id,
          settlementReference: batch.settlementReference,
          storeId: batch.storeId,
          currency: batch.currency,
          amount: batch.netAmount, // the FROZEN net — RULE 6
          bankTransferReference: evidence.bankTransferReference,
          executedAt: evidence.executedAt,
          executedBy: evidence.executedBy,
        },
      });
      await this.ledger.record(
        {
          eventType: FINANCIAL_EVENTS.SETTLEMENT_COMPLETED,
          reasonCode: 'SETTLEMENT_COMPLETED',
          actorType: 'user',
          actorId: actorUserId,
          amount: 0,
          currency: batch.currency,
          direction: 'debit',
          storeId: batch.storeId,
          idempotencyKey: ledgerIdempotencyKey(
            FINANCIAL_EVENTS.SETTLEMENT_COMPLETED,
            batch.id,
          ),
          metadata: {
            settlementReference: batch.settlementReference,
            remittanceId: created.id,
            bankTransferReference: evidence.bankTransferReference,
          },
        },
        tx,
      );
      return created;
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.batch.settled',
      targetType: 'store',
      targetId: batch.storeId,
      metadata: {
        settlementId: batchId,
        settlementReference: batch.settlementReference,
        remittanceId: remittance.id,
        itemCount: memberIds.length,
      },
    });
    return {
      batch: await this.loadBatch(batchId),
      remittance,
      replayed: false as const,
    };
  }

  // ── Read seams (SETTLE-2) — the engine is the ONLY code that
  //    touches SettlementBatch rows; consumers read through here ─────
  async frozenRecord(batchId: string) {
    const batch = await this.loadBatch(batchId);
    return {
      status: batch.status as BatchState,
      assembledBy: batch.assembledBy ?? null,
      frozen: {
        settlementId: batch.id,
        settlementReference: batch.settlementReference,
        storeId: batch.storeId,
        currency: batch.currency,
        windowType: batch.windowType,
        composition: batch.composition as Array<{
          itemId: string;
          occurrenceType: string;
          occurrenceId: string;
          amount: number;
          currency: string;
          references?: Record<string, string | null>;
        }>,
        calculationSnapshot:
          batch.calculationSnapshot as unknown as SettlementCalculation,
      },
    };
  }

  async batchItems(batchId: string) {
    await this.loadBatch(batchId);
    return this.prisma.settlementItem.findMany({
      where: { batchId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async listBatches(storeId?: string) {
    return this.prisma.settlementBatch.findMany({
      where: storeId ? { storeId } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
  }

  // Link the successor for the audit chain. Write-once, race-safe.
  async linkSuccessor(supersededId: string, successorId: string) {
    if (supersededId === successorId) {
      throw new BadRequestException('successor_cannot_be_self');
    }
    await this.loadBatch(successorId); // must exist
    const res = await this.prisma.settlementBatch.updateMany({
      where: { id: supersededId, status: 'superseded', supersededById: null },
      data: { supersededById: successorId },
    });
    if (res.count === 0) {
      const batch = await this.loadBatch(supersededId);
      if (batch.supersededById) return batch; // idempotent
      throw new ConflictException('successor_link_requires_superseded');
    }
    return this.loadBatch(supersededId);
  }

  // ── helpers ───────────────────────────────────────────────────────

  // SC §15.1 / RC 14.4: resolve each occurrence's canonical references
  // AT assembly and freeze them into the composition. The merchant's
  // legal number is SUPPLIED data quoted verbatim (RC Ch. 9 — never
  // manufactured); QB resolves through the campaign row.
  private async occurrenceReferences(
    items: Array<{ occurrenceType: string; occurrenceId: string }>,
  ) {
    const out = new Map<string, Record<string, string | null>>();
    const invoiceIds = items
      .filter((i) => i.occurrenceType === 'merchant_invoice')
      .map((i) => i.occurrenceId);
    if (invoiceIds.length === 0) return out;
    const invoices = await this.prisma.merchantInvoice.findMany({
      where: { id: { in: invoiceIds } },
      select: { id: true, merchantInvoiceNumber: true, campaignId: true },
    });
    const campaignIds = [...new Set(invoices.map((i) => i.campaignId))];
    const campaigns = campaignIds.length
      ? await this.prisma.giftCampaign.findMany({
          where: { id: { in: campaignIds } },
          select: { id: true, referenceNumber: true },
        })
      : [];
    const qbByCampaign = new Map(
      campaigns.map((c) => [c.id, c.referenceNumber]),
    );
    for (const inv of invoices) {
      out.set(`merchant_invoice:${inv.id}`, {
        merchantInvoiceNumber: inv.merchantInvoiceNumber ?? null,
        campaignReference: qbByCampaign.get(inv.campaignId) ?? null,
      });
    }
    return out;
  }

  private async loadBatch(batchId: string) {
    const batch = await this.prisma.settlementBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('settlement_batch_not_found');
    return batch;
  }

  private eligibleItems(storeId: string, currency: string) {
    return this.prisma.settlementItem.findMany({
      where: {
        storeId,
        state: 'eligible',
        currency: currency.toUpperCase(),
      },
      // §34.4 fixed iteration order — id tie-break so TIMESTAMP(3)
      // collisions cannot reorder a composition between reads.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}

function toCalculatorInput(item: {
  id: string;
  occurrenceType: string;
  occurrenceId: string;
  amount: unknown;
  currency: string;
}): SettlementItemInput {
  return {
    itemId: item.id,
    occurrenceType: item.occurrenceType,
    occurrenceId: item.occurrenceId,
    amount: moneyToNumber(item.amount as never),
    currency: item.currency,
  };
}
