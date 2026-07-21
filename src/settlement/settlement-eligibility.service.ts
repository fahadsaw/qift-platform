// SETTLE-1 eligibility (Track C PR 2) — SC v2.0 §5, executable.
//
// An item moves pending → eligible ONLY when every §5 condition holds.
// Each condition is evaluated explicitly, each carries the POLICY
// VERSION that defined it at evaluation time, and the full enumerated
// result is audited (§17.1) — an item that stays pending always says
// exactly why. Conditions the pilot cannot yet observe are recorded as
// versioned pilot policies, never silently skipped:
//
//   1 money_received        Σ receipts ≥ invoice total (re-verified —
//                           cash settles, accruals never)
//   2 delivery_state        'claim_window_settled@pilot-1': every claim
//                           of the campaign is terminal — claimed /
//                           declined / expired (incl. lazily-expired
//                           pending claims past expiresAt). Corporate
//                           fulfillment is ops-manual at pilot, so
//                           window-settled IS the constitutional
//                           "delivered or claim window closed" default
//                           (§5.2 delegates this per policy version).
//   3 dispute_free          'no_dispute_system@pilot-1': no dispute /
//                           chargeback subsystem exists yet (§9 wiring
//                           lands with the refunds PR); holds cover
//                           interim manual freezes.
//   4 payout_identity       Store.payoutIdentityVerifiedAt set (§5.4 —
//                           ops-verified at onboarding; §20 identity law)
//   5 no_blocking_hold      item carries no hold (§6)
//   6 threshold             'threshold_zero@pilot-1': minimum-remittance
//                           threshold 0 at pilot; below-threshold items
//                           roll forward, never forfeited
//   7 platform_gates        Ch. 17.4 attestation config (same gate the
//                           receipts write path enforces)
//
// RULE 2: "now" (lazy-expiry checks) comes from the injectable clock.

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { moneyToNumber, toMinor } from '../fees/money';
import { NON_PARTICIPATION_STATUSES } from '../corporate/report.service';
import { assertItemTransition, type ItemState } from './settlement-states';
import { SETTLEMENT_CLOCK, type SettlementClock } from './settlement-clock';

export const ELIGIBILITY_POLICY_VERSIONS = {
  delivery_state: 'claim_window_settled@pilot-1',
  dispute_free: 'no_dispute_system@pilot-1',
  threshold: 'threshold_zero@pilot-1',
  platform_gates: 'gates_attestation_env@pilot-1',
} as const;

const GATES_ENV = 'QIFT_FINANCIAL_GATES_ATTESTED';

// Terminal claim resting states — nothing further can happen to them.
// SHARED with the org report's canonical non-participation list
// (report.service.ts) so the two can never diverge: claimed is the
// participating terminal; declined/expired/mismatch/revoked are the
// non-participating terminals (a 'mismatch' click must release the
// window, not wedge the merchant's settlement — review finding 2).
const TERMINAL_CLAIM_STATES = new Set([
  'claimed',
  ...NON_PARTICIPATION_STATUSES,
]);

type ConditionResult = {
  condition: string;
  met: boolean;
  policyVersion?: string;
  detail?: Record<string, unknown>;
};

@Injectable()
export class SettlementEligibilityService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    @Inject(SETTLEMENT_CLOCK) private clock: SettlementClock,
  ) {}

  // ── §5.4 payout identity — ops verification action ────────────────
  async verifyPayoutIdentity(
    actorUserId: string,
    storeId: string,
    evidence: string,
  ) {
    if (typeof storeId !== 'string' || !storeId.trim()) {
      throw new BadRequestException('store_id_required');
    }
    const trimmed = typeof evidence === 'string' ? evidence.trim() : '';
    if (!trimmed) {
      // Evidence names the verification artifact — never bank details.
      throw new BadRequestException('payout_identity_evidence_required');
    }
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('store_not_found');
    const updated = await this.prisma.store.update({
      where: { id: storeId },
      data: {
        payoutIdentityVerifiedAt: this.clock.now(),
        payoutIdentityEvidence: trimmed,
      },
      select: {
        id: true,
        payoutIdentityVerifiedAt: true,
        payoutIdentityEvidence: true,
      },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'settlement.payout_identity.verified',
      targetType: 'store',
      targetId: storeId,
      metadata: {
        evidence: trimmed,
        verifiedAt: updated.payoutIdentityVerifiedAt?.toISOString(),
      },
    });
    return updated;
  }

  // ── §5 evaluation over a store's pending items ────────────────────
  async evaluate(actorUserId: string, storeId: string) {
    if (typeof storeId !== 'string' || !storeId.trim()) {
      throw new BadRequestException('store_id_required');
    }
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, payoutIdentityVerifiedAt: true },
    });
    if (!store) throw new NotFoundException('store_not_found');
    const items = await this.prisma.settlementItem.findMany({
      where: { storeId, state: 'pending' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const results: Array<{
      settlementItemId: string;
      occurrenceId: string;
      state: string;
      outcome: 'eligible' | 'pending' | 'contended';
      conditions: ConditionResult[];
    }> = [];
    for (const item of items) {
      const conditions = await this.evaluateItem(item, store);
      const allMet = conditions.every((c) => c.met);
      if (allMet) {
        assertItemTransition(item.state as ItemState, 'eligible');
        // Guarded: the item must still be exactly as read (a racing
        // hold or evaluator loses cleanly).
        const moved = await this.prisma.settlementItem.updateMany({
          where: { id: item.id, state: 'pending', batchId: null },
          data: { state: 'eligible' },
        });
        if (moved.count !== 1) {
          // The guarded transition lost a race — audited too (§17.1:
          // the enumerated conditions of every evaluation survive).
          await this.audit.record({
            actorUserId,
            actorType: 'user',
            action: 'settlement.item.contended',
            targetType: 'store',
            targetId: storeId,
            metadata: {
              settlementItemId: item.id,
              occurrenceType: item.occurrenceType,
              occurrenceId: item.occurrenceId,
              conditions: conditions.map((c) => ({
                condition: c.condition,
                met: c.met,
                ...(c.policyVersion ? { policyVersion: c.policyVersion } : {}),
              })),
            },
          });
          results.push({
            settlementItemId: item.id,
            occurrenceId: item.occurrenceId,
            state: item.state,
            outcome: 'contended' as const,
            conditions,
          });
          continue;
        }
      }
      await this.audit.record({
        actorUserId,
        actorType: 'user',
        action: allMet
          ? 'settlement.item.eligible'
          : 'settlement.item.still_pending',
        targetType: 'store',
        targetId: storeId,
        metadata: {
          settlementItemId: item.id,
          occurrenceType: item.occurrenceType,
          occurrenceId: item.occurrenceId,
          amount: moneyToNumber(item.amount),
          conditions: conditions.map((c) => ({
            condition: c.condition,
            met: c.met,
            ...(c.policyVersion ? { policyVersion: c.policyVersion } : {}),
          })),
        },
      });
      results.push({
        settlementItemId: item.id,
        occurrenceId: item.occurrenceId,
        state: allMet ? 'eligible' : 'pending',
        outcome: allMet ? ('eligible' as const) : ('pending' as const),
        conditions,
      });
    }
    return {
      storeId,
      evaluatedAt: this.clock.now().toISOString(),
      itemCount: items.length,
      eligibleCount: results.filter((r) => r.outcome === 'eligible').length,
      items: results,
    };
  }

  private async evaluateItem(
    item: {
      occurrenceType: string;
      occurrenceId: string;
      amount: unknown;
      holdType: string | null;
    },
    store: { payoutIdentityVerifiedAt: Date | null },
  ): Promise<ConditionResult[]> {
    const out: ConditionResult[] = [];

    // 1 — money actually received (re-verified against receipts).
    let campaignId: string | null = null;
    if (item.occurrenceType === 'merchant_invoice') {
      const invoice = await this.prisma.merchantInvoice.findUnique({
        where: { id: item.occurrenceId },
        select: { totalAmount: true, campaignId: true, status: true },
      });
      campaignId = invoice?.campaignId ?? null;
      const receipts = invoice
        ? await this.prisma.paymentReceipt.findMany({
            where: {
              invoiceType: 'merchant_invoice',
              invoiceId: item.occurrenceId,
            },
            select: { amount: true },
          })
        : [];
      const paidMinor = receipts.reduce(
        (s, r) => s + toMinor(moneyToNumber(r.amount), 'SAR'),
        0,
      );
      const covered =
        !!invoice &&
        receipts.length > 0 &&
        paidMinor >= toMinor(moneyToNumber(invoice.totalAmount), 'SAR');
      out.push({
        condition: 'money_received',
        met: covered,
        detail: { receiptCount: receipts.length },
      });
    } else {
      // Unknown occurrence kinds never settle silently.
      out.push({
        condition: 'money_received',
        met: false,
        detail: { reason: `occurrence_type_unsupported:${item.occurrenceType}` },
      });
    }

    // 2 — delivery-state condition (pilot policy: claim window settled).
    if (campaignId) {
      const claims = await this.prisma.claimableGift.findMany({
        where: { campaignId },
        select: { status: true, expiresAt: true },
      });
      const now = this.clock.now().getTime();
      const open = claims.filter(
        (c) =>
          !TERMINAL_CLAIM_STATES.has(c.status) &&
          !(c.status === 'pending' && c.expiresAt.getTime() < now),
      );
      // Zero claims minted = dispatch has not run — there IS no
      // window to have settled. Vacuous truth would let money settle
      // before any gift exists (review finding 5); refuse instead.
      out.push({
        condition: 'delivery_state',
        met: claims.length > 0 && open.length === 0,
        policyVersion: ELIGIBILITY_POLICY_VERSIONS.delivery_state,
        detail: {
          claimCount: claims.length,
          openClaims: open.length,
          ...(claims.length === 0 ? { reason: 'no_claims_minted' } : {}),
        },
      });
    } else {
      out.push({
        condition: 'delivery_state',
        met: false,
        policyVersion: ELIGIBILITY_POLICY_VERSIONS.delivery_state,
        detail: { reason: 'campaign_unresolved' },
      });
    }

    // 3 — dispute-free (recorded pilot posture, §9 lands with refunds).
    out.push({
      condition: 'dispute_free',
      met: true,
      policyVersion: ELIGIBILITY_POLICY_VERSIONS.dispute_free,
    });

    // 4 — payout identity verified (§5.4, hard).
    out.push({
      condition: 'payout_identity_verified',
      met: store.payoutIdentityVerifiedAt !== null,
    });

    // 5 — no blocking hold (§6).
    out.push({
      condition: 'no_blocking_hold',
      met: item.holdType === null,
      ...(item.holdType ? { detail: { holdType: item.holdType } } : {}),
    });

    // 6 — minimum-remittance threshold (pilot policy: 0).
    out.push({
      condition: 'threshold',
      met: true,
      policyVersion: ELIGIBILITY_POLICY_VERSIONS.threshold,
    });

    // 7 — platform gates (Ch. 17.4 attestation).
    out.push({
      condition: 'platform_gates',
      met: process.env[GATES_ENV] === 'true',
      policyVersion: ELIGIBILITY_POLICY_VERSIONS.platform_gates,
    });

    return out;
  }
}
