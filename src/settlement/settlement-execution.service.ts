// SETTLE-2 execution surface (Track C PR 3).
//
// SC v2.0 §31–§33 + permanent RULES 4–6, executable:
//
//   preview  — §30.4 mandatory pre-execution review. Renders the
//              FROZEN snapshot via buildExecutionPreview (RULE 5),
//              §34-verified, AND records the preview ACT as an
//              append-only row — execution later requires that a
//              recorded, unlapsed preview act exists (possessing the
//              hash is not reviewing the preview).
//   approve  — §31/§32: binds to the exact frozen calculation
//              (calculationHash, RULE 6), approver ≠ proposer
//              (§31.1 L2 maker–checker), ONE ACTIVE vote per
//              identity (§31.5; a §31.3-lapsed vote may be recast as
//              a new immutable row), required level recorded from the
//              §32 matrix.
//   execute  — §33: the RULE 6 binding gate (frozen ≡ preview ≡
//              approvals, executor ∉ approvers, §34 verified),
//              recorded preview act, unlapsed distinct approvals,
//              §32 level with anti-fragmentation (aggregate INCLUDES
//              this action, measured on BOTH the bank-value day and
//              the recording day — backdating never lowers a band;
//              executedAt itself is window-bounded), §33.3 zero-drift,
//              then engine.markSettled — which creates the remittance
//              row (amount = the FROZEN net, never supplied), settles
//              batch + items, and posts the completed marker in ONE
//              transaction (the anti-double-pay atomicity) — then the
//              merchant.remittance.paid posting and the RULE 4
//              statement, both occurrence-anchored and idempotent.
//   replay   — the §34 harness: regenerates the statement from frozen
//              data + stored facts and compares hashes.
//
// Crash recovery (§18.2): the remittance row exists ONLY for settled
// batches (atomicity above), so every resume lands in exactly one
// lane: batch ready → full re-proof; batch settled → the completion
// lane, which verifies evidence identity and finishes the posting /
// statement without re-proving lapsed approvals. The sweep completes,
// never repeats — and never re-litigates a movement that happened.
//
// RULE 2: no direct system time — the clock is injected; bank dates
// are supplied evidence, bounded against the clock by policy.

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
import { moneyToNumber, toMinor } from '../fees/money';
import { SettlementEngineService } from './settlement-engine.service';
import { SETTLEMENT_CLOCK, type SettlementClock } from './settlement-clock';
import { asCurrencyCode } from './settlement-calculator';
import {
  calculationHash,
  canonicalJson,
  generateSettlementStatement,
  hashCanonical,
  statementHash,
  type FrozenBatchRecord,
  type SettlementStatement,
} from './settlement-statement';
import {
  creditNoteCanonical,
  creditNoteHash,
  type CreditNoteFacts,
} from './settlement-credit-note';
import {
  assertExecutionBinding,
  buildExecutionPreview,
  REPLAY_ENGINE_VERSION,
  type ExecutionApproval,
} from './settlement-execution-binding';
import {
  APPROVAL_POLICY,
  requiredExecutionApproval,
} from './settlement-approval-policy';

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';
// §31.1 L3 senior-finance designation — Ch. 14-recorded assignment,
// carried as deployment config at pilot (comma-separated user ids).
// Empty ⇒ no senior seat exists ⇒ L3 cannot execute (§31.1, honest).
const SENIOR_ENV = 'QIFT_SETTLEMENT_SENIOR_APPROVERS';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type ExecuteInput = {
  previewHash: string; // the reviewed preview's calculationHash
  bankTransferReference: string;
  executedAt: string; // ISO bank value date — business fact
};

type RemittanceRow = {
  id: string;
  bankTransferReference: string;
  executedAt: Date;
  amount: Parameters<typeof moneyToNumber>[0];
};

@Injectable()
export class SettlementExecutionService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private ledger: FinancialLedgerService,
    private engine: SettlementEngineService,
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
  ) {}

  // ── §30.4 preview — mandatory, recorded as an act ─────────────────
  async preview(actorUserId: string, batchId: string) {
    const { frozen, status } = await this.engine.frozenRecord(batchId);
    if (status !== 'ready') {
      throw new BadRequestException(`preview_requires_ready:${status}`);
    }
    const preview = buildExecutionPreview(frozen, {
      asOf: this.clock.now().toISOString(),
    });
    // RULE 5: the preview ACT is a recorded fact execution checks for.
    await this.prisma.settlementExecutionPreview.create({
      data: {
        settlementId: frozen.settlementId,
        settlementReference: frozen.settlementReference,
        calculationHash: preview.calculationHash,
        replayVerified: preview.replayVerified,
        previewedBy: actorUserId,
        previewedAt: this.clock.now(),
      },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.execution.previewed',
      targetType: 'store',
      targetId: frozen.storeId,
      metadata: {
        settlementId: frozen.settlementId,
        settlementReference: frozen.settlementReference,
        calculationHash: preview.calculationHash,
        replayVerified: preview.replayVerified,
        itemCount: preview.itemCount,
      },
    });
    return preview;
  }

  // ── §31/§32 approval — binds to the EXACT frozen calculation ──────
  async approve(
    actorUserId: string,
    batchId: string,
    input: { calculationHash: string; note?: string },
  ) {
    const { frozen, status, assembledBy } =
      await this.engine.frozenRecord(batchId);
    if (status !== 'ready') {
      throw new BadRequestException(`approval_requires_ready:${status}`);
    }
    if (!assembledBy) {
      // Pre-SETTLE-2 batch without a recorded proposer: the §31.1
      // maker–checker chain cannot be proven — re-assemble.
      throw new ConflictException('batch_proposer_unknown');
    }
    if (actorUserId === assembledBy) {
      // §31.1 L2: proposer ≠ approver, server-enforced above RBAC.
      throw new ConflictException('approver_cannot_be_proposer');
    }
    const frozenHash = calculationHash(frozen.calculationSnapshot);
    if (input.calculationHash !== frozenHash) {
      // §31.2: an approval attaches to exact content — a stale or
      // wrong hash approves NOTHING.
      throw new ConflictException('approval_snapshot_stale');
    }
    // §31.5: one ACTIVE vote per identity. A lapsed vote (§31.3) may
    // be recast — as a NEW immutable row, never an edit.
    const now = this.clock.now().getTime();
    const ttlMs = APPROVAL_POLICY.approvalTtlHours * HOUR_MS;
    const mine = await this.prisma.settlementApproval.findMany({
      where: { settlementId: frozen.settlementId, approvedBy: actorUserId },
      select: { approvedAt: true },
    });
    if (mine.some((r) => now - r.approvedAt.getTime() <= ttlMs)) {
      throw new ConflictException('already_approved_by_user');
    }
    const requirement = requiredExecutionApproval(
      toMinor(
        frozen.calculationSnapshot.netAmount,
        asCurrencyCode(frozen.currency),
      ),
      await this.dayAggregateMinor(
        frozen.settlementId,
        frozen.storeId,
        frozen.currency,
        this.clock.now(),
        'createdAt',
      ),
    );
    let approval;
    try {
      approval = await this.prisma.settlementApproval.create({
        data: {
          settlementId: frozen.settlementId,
          settlementReference: frozen.settlementReference,
          calculationHash: frozenHash,
          requiredLevel: requirement.level,
          approvedBy: actorUserId,
          approvedAt: this.clock.now(),
          note: input.note?.trim() || null,
        },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        // Same-instant double-submit by one identity — one vote.
        throw new ConflictException('already_approved_by_user');
      }
      throw e;
    }
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.execution.approved',
      targetType: 'store',
      targetId: frozen.storeId,
      metadata: {
        settlementId: frozen.settlementId,
        settlementReference: frozen.settlementReference,
        calculationHash: frozenHash,
        requiredLevel: requirement.level,
        band: requirement.aggregateBand,
        policyVersion: requirement.policyVersion,
      },
    });
    return { approval, requirement };
  }

  // ── §33 execute — only from an approved, RECORDED preview ─────────
  async execute(actorUserId: string, batchId: string, input: ExecuteInput) {
    this.assertGatesOpen(); // Ch. 17.4: money may not MOVE either
    const bankTransferReference =
      typeof input.bankTransferReference === 'string'
        ? input.bankTransferReference.trim()
        : '';
    if (!bankTransferReference) {
      throw new BadRequestException('remittance_bank_reference_required');
    }
    const executedAt = new Date(input.executedAt);
    if (Number.isNaN(executedAt.getTime())) {
      throw new BadRequestException('remittance_executed_at_invalid');
    }
    const { frozen, status, assembledBy } =
      await this.engine.frozenRecord(batchId);
    if (status !== 'ready' && status !== 'settled') {
      throw new BadRequestException(`execution_requires_ready:${status}`);
    }
    const currency = asCurrencyCode(frozen.currency);
    const netMinor = toMinor(frozen.calculationSnapshot.netAmount, currency);
    if (netMinor <= 0) {
      // Zero-net batches issue statements without a bank movement
      // (§4) and negative nets are the receivable flow — both are a
      // tracked later lane, never a fabricated transfer.
      throw new BadRequestException('execution_requires_positive_net');
    }
    if (status === 'settled') {
      // §18.2 completion lane: the movement already happened lawfully
      // (remittance exists ⇔ settled, atomically). Verify identity,
      // finish the chain, never re-litigate lapsed approvals.
      const remittance = await this.prisma.settlementRemittance.findUnique({
        where: { settlementId: frozen.settlementId },
      });
      if (!remittance) {
        throw new ConflictException('settled_without_remittance');
      }
      this.assertRemittanceIdentity(
        remittance,
        bankTransferReference,
        executedAt,
        netMinor,
        currency,
      );
      return this.completeChain(actorUserId, frozen, remittance, {
        healed: true,
        proposer: assembledBy,
        approvedBy: null,
      });
    }

    // §32.3 defense: the bank value date is window-bounded — a
    // movement outside [now − maxAge, now + skew] cannot ride the
    // routine lane (backdating around the day aggregate).
    const nowMs = this.clock.now().getTime();
    if (
      nowMs - executedAt.getTime() >
        APPROVAL_POLICY.executedAtMaxAgeHours * HOUR_MS ||
      executedAt.getTime() - nowMs >
        APPROVAL_POLICY.executedAtMaxSkewHours * HOUR_MS
    ) {
      throw new BadRequestException('remittance_executed_at_out_of_window');
    }

    // RULE 6 gate: frozen ≡ preview ≡ approvals, §34 verified,
    // executor ∉ approvers.
    const preview = buildExecutionPreview(frozen, {
      asOf: this.clock.now().toISOString(),
    });
    if (input.previewHash !== preview.calculationHash) {
      throw new ConflictException('preview_hash_mismatch');
    }
    // RULE 5: a RECORDED, unlapsed preview act must exist for exactly
    // this frozen calculation — the §33.4 "simulation reviewed" act.
    const ttlMs = APPROVAL_POLICY.approvalTtlHours * HOUR_MS;
    const previewActs = await this.prisma.settlementExecutionPreview.findMany({
      where: {
        settlementId: frozen.settlementId,
        calculationHash: preview.calculationHash,
      },
      select: { previewedAt: true },
    });
    if (
      !previewActs.some((p) => nowMs - p.previewedAt.getTime() <= ttlMs)
    ) {
      throw new ConflictException('preview_act_required');
    }

    // §31.3 TTL + §31.5 distinct identities: latest vote per approver,
    // active only.
    const rows = await this.prisma.settlementApproval.findMany({
      where: { settlementId: frozen.settlementId },
      orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
    });
    const latestByApprover = new Map<string, (typeof rows)[number]>();
    for (const r of rows) latestByApprover.set(r.approvedBy, r);
    const active = [...latestByApprover.values()].filter(
      (r) => nowMs - r.approvedAt.getTime() <= ttlMs,
    );
    const approvals: ExecutionApproval[] = active.map((r) => ({
      settlementId: r.settlementId,
      settlementReference: r.settlementReference,
      calculationHash: r.calculationHash,
      approvedBy: r.approvedBy,
      level: r.requiredLevel,
      approvedAt: r.approvedAt.toISOString(),
    }));
    assertExecutionBinding(frozen, preview, approvals, actorUserId);

    // §32 level at EXECUTION time (authoritative). Anti-fragmentation:
    // the aggregate includes this action, measured on BOTH the bank-
    // value day (evidence basis) and the RECORDING day (server-truth
    // createdAt — a backdated value date cannot duck it) — the wider
    // band governs.
    const [aggValueDay, aggRecordingDay] = await Promise.all([
      this.dayAggregateMinor(
        frozen.settlementId,
        frozen.storeId,
        frozen.currency,
        executedAt,
        'executedAt',
      ),
      this.dayAggregateMinor(
        frozen.settlementId,
        frozen.storeId,
        frozen.currency,
        this.clock.now(),
        'createdAt',
      ),
    ]);
    const requirement = requiredExecutionApproval(
      netMinor,
      Math.max(aggValueDay, aggRecordingDay),
    );
    if (approvals.length < requirement.approvalsNeeded) {
      throw new ConflictException('insufficient_approvals');
    }
    if (requirement.seniorRequired) {
      const seniors = new Set(
        (process.env[SENIOR_ENV] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      if (!approvals.some((a) => seniors.has(a.approvedBy))) {
        // §31.1 L3: without a senior seat this CANNOT execute. The
        // constraint is the hiring requirement — never a bypass.
        throw new ConflictException('senior_approval_required');
      }
    }

    // §33.3 drift check: every frozen item is still ready and bound —
    // a landed hold or dispute refuses execution and returns the
    // batch for re-simulation (the supersession lane).
    const items = await this.engine.batchItems(batchId);
    const ready = new Map(items.map((i) => [i.id, i.state]));
    for (const c of frozen.composition) {
      if (ready.get(c.itemId) !== 'ready') {
        throw new ConflictException('batch_drifted');
      }
    }

    // ── The close: remittance + settled + completed marker, ONE
    //    transaction inside the engine (anti-double-pay atomicity);
    //    then the idempotent posting + statement (§18.2 completes). ──
    const settled = await this.engine.markSettled(actorUserId, batchId, {
      bankTransferReference,
      executedAt,
      executedBy: actorUserId,
    });
    if (settled.replayed) {
      // A concurrent same-evidence executor won the close — verify and
      // finish, never duplicate.
      this.assertRemittanceIdentity(
        settled.remittance,
        bankTransferReference,
        executedAt,
        netMinor,
        currency,
      );
    }
    return this.completeChain(actorUserId, frozen, settled.remittance, {
      healed: false,
      proposer: assembledBy,
      approvedBy: approvals.map((a) => a.approvedBy),
      requirement,
    });
  }

  // ── Statement retrieval (the issued document, immutable) ──────────
  // HARDENING req. 5: integrity is verified BEFORE the document
  // renders — a tampered record never leaves this method as an
  // authentic statement. The response carries the CANONICAL JSON (the
  // source of truth every presentation layer derives from) and any
  // accumulated signature envelopes.
  async statement(batchId: string) {
    const { frozen } = await this.engine.frozenRecord(batchId);
    const record = await this.prisma.settlementStatementRecord.findUnique({
      where: { settlementId: frozen.settlementId },
    });
    if (!record) throw new NotFoundException('statement_not_issued');
    if (!this.statementIntegrityOk(record)) {
      throw new ConflictException('statement_integrity_violation');
    }
    const signatures = await this.prisma.settlementStatementSignature.findMany({
      where: { settlementId: frozen.settlementId },
      orderBy: [{ signedAt: 'asc' }, { id: 'asc' }],
    });
    return { ...record, signatures };
  }

  // ── §34 replay harness — frozen data in, identical statement out ──
  // HARDENING req. 4+5: integrity of the STORED record is verified
  // FIRST (canonical bytes → hash, and payload ↔ canonical agreement);
  // a tampered store is surfaced, never rendered as authentic — the
  // regenerated statement (from frozen data) remains the trustworthy
  // rendering either way. Every run is persisted with the replay
  // engine version that produced the verdict.
  async replay(actorUserId: string, batchId: string) {
    const { frozen } = await this.engine.frozenRecord(batchId);
    const record = await this.prisma.settlementStatementRecord.findUnique({
      where: { settlementId: frozen.settlementId },
    });
    if (!record) throw new NotFoundException('statement_not_issued');
    // Req. 5 — integrity BEFORE rendering.
    const statementIntegrityVerified = this.statementIntegrityOk(record);
    const remittance = await this.prisma.settlementRemittance.findUnique({
      where: { settlementId: frozen.settlementId },
    });
    // Recompute-and-compare through the ONE calculator (RULE 5)...
    const preview = buildExecutionPreview(frozen, {
      asOf: record.issuedAt.toISOString(),
    });
    // ...and regenerate the statement from frozen data + STORED facts.
    const regenerated = generateSettlementStatement(frozen, {
      issuedAt: record.issuedAt.toISOString(),
      remittance: remittance
        ? {
            remittanceId: remittance.id,
            bankTransferReference: remittance.bankTransferReference,
            executedAt: remittance.executedAt.toISOString(),
            amount: moneyToNumber(remittance.amount),
          }
        : null,
    });
    const regeneratedHash = statementHash(regenerated);
    const identical =
      statementIntegrityVerified && regeneratedHash === record.statementHash;
    // Req. 4 — the run is a RECORDED verification act with its engine
    // version (append-only).
    const replayRecord = await this.prisma.settlementReplayRecord.create({
      data: {
        settlementId: frozen.settlementId,
        settlementReference: frozen.settlementReference,
        replayEngineVersion: REPLAY_ENGINE_VERSION,
        calculationReplayVerified: preview.replayVerified,
        statementIntegrityVerified,
        statementIdentical: identical,
        ranBy: actorUserId,
        ranAt: this.clock.now(),
      },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.replay.executed',
      targetType: 'store',
      targetId: frozen.storeId,
      metadata: {
        settlementId: frozen.settlementId,
        settlementReference: frozen.settlementReference,
        replayEngineVersion: REPLAY_ENGINE_VERSION,
        replayRecordId: replayRecord.id,
        calculationReplayVerified: preview.replayVerified,
        statementIntegrityVerified,
        statementIdentical: identical,
      },
    });
    return {
      settlementReference: frozen.settlementReference,
      replayEngineVersion: REPLAY_ENGINE_VERSION,
      calculationReplayVerified: preview.replayVerified,
      statementIntegrityVerified,
      statementIdentical: identical,
      storedStatementHash: record.statementHash,
      regeneratedStatementHash: regeneratedHash,
      // The REGENERATED statement — always derived from frozen data,
      // trustworthy even when the stored record is not.
      statement: regenerated as SettlementStatement,
    };
  }

  async listBatches(storeId?: string) {
    return this.engine.listBatches(storeId);
  }

  // ── internals ─────────────────────────────────────────────────────

  // The post-settle tail: payable-extinguishing posting + RULE 4
  // statement + the §33.4 evidence-chain audit. Every step is
  // occurrence-anchored and idempotent — a crash re-runs to
  // completion via the settled lane (§18.2).
  private async completeChain(
    actorUserId: string,
    frozen: FrozenBatchRecord,
    remittance: RemittanceRow,
    trail: {
      healed: boolean;
      proposer: string | null;
      approvedBy: string[] | null;
      requirement?: { level: number; policyVersion: string };
    },
  ) {
    await this.ledger.record({
      eventType: FINANCIAL_EVENTS.MERCHANT_REMITTANCE_PAID,
      reasonCode: 'MERCHANT_REMITTANCE',
      actorType: 'user',
      actorId: actorUserId,
      amount: moneyToNumber(remittance.amount),
      currency: frozen.currency,
      direction: 'credit', // reduces what Qift owes (FC v1.0.1 Ch. 6.4 form)
      counterpartyType: 'merchant',
      storeId: frozen.storeId,
      idempotencyKey: ledgerIdempotencyKey(
        FINANCIAL_EVENTS.MERCHANT_REMITTANCE_PAID,
        remittance.id,
      ),
      metadata: {
        settlementId: frozen.settlementId,
        settlementReference: frozen.settlementReference,
        bankTransferReference: remittance.bankTransferReference,
        account: 'safeguarding',
      },
    });
    const statementRecord = await this.ensureStatement(frozen, remittance);
    // RC v3.0: the enumerating statement now exists — attach it to
    // every credit note whose receivable this batch recovered.
    // Write-once (guarded on null), regenerating the canonical bytes
    // and hash as a NEW DOCUMENT VERSION (the null was part of the
    // hashed document), audited — never a silent rewrite.
    await this.attachStatementToCreditNotes(actorUserId, frozen);
    // §33.4 evidence chain — the heal lane audits too (a crashed
    // execution's completion must appear in the trail).
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: trail.healed
        ? 'settlement.execution.healed'
        : 'settlement.batch.executed',
      targetType: 'store',
      targetId: frozen.storeId,
      metadata: {
        settlementId: frozen.settlementId,
        settlementReference: frozen.settlementReference,
        remittanceId: remittance.id,
        bankTransferReference: remittance.bankTransferReference,
        amount: moneyToNumber(remittance.amount),
        currency: frozen.currency,
        executedBy: actorUserId,
        proposer: trail.proposer,
        ...(trail.approvedBy ? { approvedBy: trail.approvedBy } : {}),
        ...(trail.requirement
          ? {
              requiredLevel: trail.requirement.level,
              policyVersion: trail.requirement.policyVersion,
            }
          : {}),
        statementHash: statementRecord?.statementHash,
      },
    });
    return {
      settlementReference: frozen.settlementReference,
      remittance,
      statement: statementRecord,
    };
  }

  private assertRemittanceIdentity(
    remittance: RemittanceRow,
    bankTransferReference: string,
    executedAt: Date,
    netMinor: number,
    currency: ReturnType<typeof asCurrencyCode>,
  ) {
    if (
      remittance.bankTransferReference !== bankTransferReference ||
      remittance.executedAt.getTime() !== executedAt.getTime() ||
      toMinor(moneyToNumber(remittance.amount), currency) !== netMinor
    ) {
      // A DIFFERENT movement against the same batch is a §18.3
      // incident, never silently merged.
      throw new ConflictException('remittance_conflict');
    }
  }

  private async attachStatementToCreditNotes(
    actorUserId: string,
    frozen: FrozenBatchRecord,
  ) {
    for (const alloc of frozen.recoveryAllocation ?? []) {
      const note = await this.prisma.creditNote.findUnique({
        where: { refundId: alloc.occurrenceId },
      });
      if (!note || note.statementSettlementId !== null) continue; // write-once
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
        netComponent:
          note.netComponent === null ? null : moneyToNumber(note.netComponent),
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
        statementSettlementId: frozen.settlementId,
      };
      const canonical = creditNoteCanonical(facts);
      const documentHash = creditNoteHash(facts);
      // APPEND-ONLY (C-PR8): the issued version's bytes are NEVER
      // rewritten — the next version appends to CreditNoteVersion and
      // the head row advances its CURRENT cache + version pointer.
      const attached = await this.prisma.creditNote.updateMany({
        where: { refundId: alloc.occurrenceId, statementSettlementId: null },
        data: {
          statementSettlementId: frozen.settlementId,
          canonicalJson: canonical,
          documentHash,
          currentVersion: note.currentVersion + 1,
        },
      });
      if (attached.count === 1) {
        await this.prisma.creditNoteVersion.create({
          data: {
            creditNoteId: note.id,
            versionNumber: note.currentVersion + 1,
            changeReason: 'statement_attached',
            canonicalJson: canonical,
            documentHash,
            statementSettlementId: frozen.settlementId,
            createdBy: actorUserId,
          },
        });
        await this.audit.record({
          actorUserId,
          actorType: 'user',
          action: 'settlement.credit_note.statement_attached',
          targetType: 'store',
          targetId: frozen.storeId,
          metadata: {
            creditNoteReference: note.referenceNumber,
            refundId: note.refundId,
            settlementId: frozen.settlementId,
            settlementReference: frozen.settlementReference,
            documentVersion: 'v1',
          },
        });
      }
    }
  }

  private async ensureStatement(
    frozen: FrozenBatchRecord,
    remittance: RemittanceRow,
  ) {
    const issuedAt = this.clock.now();
    const statement = generateSettlementStatement(frozen, {
      issuedAt: issuedAt.toISOString(),
      remittance: {
        remittanceId: remittance.id,
        bankTransferReference: remittance.bankTransferReference,
        executedAt: remittance.executedAt.toISOString(),
        amount: moneyToNumber(remittance.amount),
      },
    });
    // HARDENING req. 1+2: the canonical string is stored as the source
    // of truth, and the hash is computed FROM THOSE BYTES — one
    // serialization, one digest, stored together.
    const canonical = canonicalJson(statement);
    try {
      return await this.prisma.settlementStatementRecord.create({
        data: {
          settlementId: frozen.settlementId,
          settlementReference: frozen.settlementReference,
          storeId: frozen.storeId,
          statementVersion: statement.statementVersion,
          payload: statement as never,
          canonicalJson: canonical,
          statementHash: hashCanonical(canonical),
          issuedAt,
        },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        // Already issued — immutable; the stored document stands.
        return this.prisma.settlementStatementRecord.findUnique({
          where: { settlementId: frozen.settlementId },
        });
      }
      throw e;
    }
  }

  // HARDENING req. 5: a stored statement is authentic only when the
  // stored canonical bytes hash to the stored digest AND the payload
  // re-canonicalizes to those exact bytes — any drift between the
  // three representations is an integrity violation.
  private statementIntegrityOk(record: {
    payload: unknown;
    canonicalJson: string;
    statementHash: string;
  }): boolean {
    return (
      hashCanonical(record.canonicalJson) === record.statementHash &&
      canonicalJson(record.payload) === record.canonicalJson
    );
  }

  // §32.3 anti-fragmentation: Σ OTHER remittances (same store,
  // currency) on the same UTC day — the batch's own settlement is
  // excluded (its net is added by the policy function). Two bases:
  //   executedAt — the bank value day (operator-supplied evidence);
  //   createdAt  — the RECORDING day (server truth, un-backdatable).
  // The level check takes the max across both, so spreading value
  // dates inside the window never lowers the band the true recording
  // day demands.
  private async dayAggregateMinor(
    ownSettlementId: string,
    storeId: string,
    currency: string,
    at: Date,
    basis: 'executedAt' | 'createdAt',
  ) {
    const dayStart = new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const rows = await this.prisma.settlementRemittance.findMany({
      where: {
        storeId,
        currency,
        settlementId: { not: ownSettlementId },
        [basis]: { gte: dayStart, lt: dayEnd },
      },
      select: { amount: true },
    });
    const code = asCurrencyCode(currency);
    return rows.reduce(
      (s, r) => s + toMinor(moneyToNumber(r.amount), code),
      0,
    );
  }

  private assertGatesOpen() {
    if (process.env[GATES_ENV] !== 'true') {
      throw new ConflictException('financial_gates_not_attested');
    }
  }
}
