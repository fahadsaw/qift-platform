// RosterPurgeService — hard-deletes CorporateContact rows whose
// purgeAfter has passed (Corporate Foundation PR 2).
//
// This is the enforcement half of the retention promise: every
// roster row is born with a purge deadline, and this sweeper makes
// the deadline real. Hard DELETE, not soft — the point is that the
// data stops existing (Corporate Core v2 §3: roster data is
// borrowed, not owned).
//
// House worker pattern (GiftsAutoDefaultService): plain setInterval,
// test-env skip, boot kick, unref, idempotent under replicas
// (deleteMany is atomic; two workers racing just split the count).
// Activation is env-gated DEFAULT OFF — flip
// QIFT_ROSTER_PURGE_ENABLED='true' on Railway when the first org is
// onboarded.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// Six hours: retention windows are measured in days, so worst-case
// lateness of ~6h is invisible while keeping the sweep cheap.
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Campaign states that PROTECT a contact from purging (PR 3): a
// contact selected into a submitted/approved/in-flight campaign must
// not vanish from under it mid-wave. Draft campaigns deliberately do
// NOT protect — an abandoned draft must never pin roster PII past
// its retention deadline. Once the campaign reaches a terminal state
// (completed / cancelled), protection lapses and the next sweep
// collects the row.
const PURGE_PROTECTING_CAMPAIGN_STATES = [
  'pending_approval',
  'approved',
  'dispatching',
] as const;

@Injectable()
export class RosterPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RosterPurgeService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  onModuleInit() {
    // Tests call runOnce() directly; no open handles under Jest.
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.QIFT_ROSTER_PURGE_ENABLED !== 'true') {
      this.logger.log(
        'Roster purge worker disabled (QIFT_ROSTER_PURGE_ENABLED != true)',
      );
      return;
    }
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Public for tests + future ops trigger.
  async runOnce(): Promise<{ deleted: number }> {
    try {
      const result = await this.prisma.corporateContact.deleteMany({
        where: {
          purgeAfter: { lt: new Date() },
          campaignRecipients: {
            none: {
              campaign: {
                status: { in: [...PURGE_PROTECTING_CAMPAIGN_STATES] },
              },
            },
          },
        },
      });
      if (result.count > 0) {
        this.logger.log(`Roster purge: deleted ${result.count} expired rows`);
        // System action — no human actor. Metadata is a count only;
        // the deleted rows are gone and the audit trail must not
        // resurrect their PII.
        await this.audit.record({
          actorUserId: null,
          actorType: 'system',
          action: 'system.roster.purge',
          targetType: 'system',
          targetId: null,
          metadata: { deleted: result.count },
        });
      }
      return { deleted: result.count };
    } catch (err) {
      this.logger.warn(`Roster purge sweep failed: ${(err as Error).message}`);
      return { deleted: 0 };
    }
  }
}
