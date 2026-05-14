// Tests for the OccasionReminderWorker. The worker is the
// load-bearing piece that activates Phase 6 reminder data —
// these specs lock down:
//   1. Feature-flag gating (default OFF)
//   2. Firing-window math (only on the days-before UTC day)
//   3. Idempotency via the ReminderFiring unique constraint
//   4. Per-user rollout (allowlist / sample percent / dry-run)
//   5. Orchestrator call shape (correct category + link)
//   6. Crash safety (orchestrator throw leaves 'claimed' row)

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { OccasionReminderWorker } from './occasion-reminder-worker.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationCategory } from './notification-categories';

const ENV_KEYS = [
  'QIFT_OCCASION_REMINDER_FIRING_ENABLED',
  'QIFT_REMINDER_DRY_RUN',
  'QIFT_REMINDER_ALLOWLIST',
  'QIFT_REMINDER_USER_SAMPLE_PERCENT',
];
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function enableFiring() {
  process.env.QIFT_OCCASION_REMINDER_FIRING_ENABLED = 'true';
}

type MockPrisma = {
  occasionReminder: { findMany: jest.Mock };
  reminderFiring: {
    create: jest.Mock;
    update: jest.Mock;
    // Stale-claim observability — `count` is called on every
    // runOnce(); cleanup-related methods are exercised only by
    // the cleanupStaleClaims specs further down.
    count: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
};

function createPrismaMock(): MockPrisma {
  return {
    occasionReminder: { findMany: jest.fn().mockResolvedValue([]) },
    reminderFiring: {
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

// Helper — builds a candidate row matching the worker's expected
// `select` shape. Defaults: yearly birthday on June 15.
function candidate(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'rem_1',
    userId: 'user_1',
    daysBefore: 7,
    occasion: {
      id: 'occ_1',
      calendar: 'gregorian',
      year: null,
      month: 6,
      day: 15,
      recurrence: 'yearly',
      label: "Sarah's birthday",
      kind: 'birthday',
      ...(overrides.occasion as object | undefined),
    },
    ...overrides,
  };
}

describe('OccasionReminderWorker', () => {
  let worker: OccasionReminderWorker;
  let prisma: MockPrisma;
  let orchestrator: { enqueue: jest.Mock };

  beforeEach(async () => {
    clearEnv();
    prisma = createPrismaMock();
    orchestrator = {
      enqueue: jest.fn().mockResolvedValue({
        kind: 'sent',
        notificationId: 'n_1',
        category: 'occasion_reminder',
        pushed: true,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OccasionReminderWorker,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationOrchestrator, useValue: orchestrator },
      ],
    }).compile();
    worker = module.get<OccasionReminderWorker>(OccasionReminderWorker);
  });
  afterAll(clearEnv);

  describe('feature-flag gating', () => {
    it('skips entirely when QIFT_OCCASION_REMINDER_FIRING_ENABLED is off', async () => {
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      expect(out.ran).toBe(false);
      expect(out.skippedReason).toBe('feature_flag_off');
      expect(prisma.occasionReminder.findMany).not.toHaveBeenCalled();
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });

    it('runs when flag is on', async () => {
      enableFiring();
      prisma.occasionReminder.findMany.mockResolvedValueOnce([]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      expect(out.ran).toBe(true);
      expect(prisma.occasionReminder.findMany).toHaveBeenCalledTimes(1);
    });

    it('forceDryRun bypasses the activation flag', async () => {
      // Operators can preview without flipping the env. The
      // worker runs candidate selection + logs but skips writes.
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
        forceDryRun: true,
      });
      expect(out.ran).toBe(true);
      expect(out.filteredDryRun).toBe(1);
      expect(prisma.reminderFiring.create).not.toHaveBeenCalled();
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('firing-window math', () => {
    beforeEach(enableFiring);

    it('fires when now is exactly the days-before UTC day', async () => {
      // June 15 birthday, 7 days before = June 8.
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8, 14, 30, 0)), // June 8, mid-afternoon
      });
      expect(out.inWindow).toBe(1);
      expect(out.fired).toBe(1);
      expect(orchestrator.enqueue).toHaveBeenCalledTimes(1);
    });

    it('skips when now is before the firing day', async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 1)), // June 1 — too early
      });
      expect(out.inWindow).toBe(0);
      expect(out.fired).toBe(0);
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });

    it('skips when now is after the firing day (downtime case)', async () => {
      // T-7 firing day was June 8. If the worker first runs on
      // June 10, we DON'T retroactively fire — the moment passed.
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 10)),
      });
      expect(out.inWindow).toBe(0);
      expect(out.fired).toBe(0);
    });

    it('handles daysBefore=0 (fire on the occurrence day itself)', async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([
        candidate({ daysBefore: 0 }),
      ]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 15)), // June 15
      });
      expect(out.inWindow).toBe(1);
      expect(out.fired).toBe(1);
    });

    it("doesn't fire for once-only occasions that have passed", async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([
        candidate({
          occasion: {
            id: 'occ_grad',
            calendar: 'gregorian',
            year: 2024, // past
            month: 6,
            day: 15,
            recurrence: 'once',
            label: 'Graduation',
            kind: 'graduation',
          },
        }),
      ]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      // nextOccurrence returns null for past once-only events;
      // the worker silently moves on without counting it in-window.
      expect(out.inWindow).toBe(0);
      expect(out.fired).toBe(0);
    });
  });

  describe('idempotency', () => {
    beforeEach(enableFiring);

    it('writes ReminderFiring BEFORE calling the orchestrator', async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      await worker.runOnce({ now: new Date(Date.UTC(2026, 5, 8)) });
      // Assert order: create was invoked first, orchestrator next.
      const createOrder =
        prisma.reminderFiring.create.mock.invocationCallOrder[0];
      const enqueueOrder = orchestrator.enqueue.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(enqueueOrder);
    });

    it('skips on unique-constraint violation (already fired)', async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      // Simulate the second worker run racing on the same
      // (reminder, occurrence). The unique key throws P2002.
      const err: any = new Error('Unique constraint failed');
      err.code = 'P2002';
      prisma.reminderFiring.create.mockRejectedValueOnce(err);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      // Worker considered it in-window but didn't fire — the
      // claim was held by a prior run.
      expect(out.inWindow).toBe(1);
      expect(out.fired).toBe(0);
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });

    it('updates the ReminderFiring row with the orchestrator result', async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      orchestrator.enqueue.mockResolvedValueOnce({
        kind: 'suppressed',
        category: NotificationCategory.OccasionReminder,
        reason: 'user_opted_out',
      });
      await worker.runOnce({ now: new Date(Date.UTC(2026, 5, 8)) });
      expect(prisma.reminderFiring.update).toHaveBeenCalledWith({
        where: { id: 'rf_1' },
        data: { status: 'suppressed', reason: 'user_opted_out' },
      });
    });

    it("leaves 'claimed' row on orchestrator crash (no re-fire on retry)", async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      orchestrator.enqueue.mockRejectedValueOnce(new Error('db down'));
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      expect(out.errors).toBe(1);
      expect(out.fired).toBe(0);
      // CRUCIAL: the update call should NOT have flipped the row
      // out of 'claimed' state — that's what holds the claim and
      // prevents a duplicate retry on the next run.
      expect(prisma.reminderFiring.update).not.toHaveBeenCalled();
    });
  });

  describe('per-user rollout gates', () => {
    beforeEach(enableFiring);

    it('skips users not on the allowlist', async () => {
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_2';
      prisma.occasionReminder.findMany.mockResolvedValueOnce([
        candidate({ userId: 'user_1' }),
      ]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      expect(out.filteredAllowlist).toBe(1);
      expect(out.fired).toBe(0);
      expect(prisma.reminderFiring.create).not.toHaveBeenCalled();
    });

    it('processes allowlisted users normally', async () => {
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_1';
      prisma.occasionReminder.findMany.mockResolvedValueOnce([
        candidate({ userId: 'user_1' }),
      ]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      expect(out.filteredAllowlist).toBe(0);
      expect(out.fired).toBe(1);
    });

    it('skips users outside the sample-percent bucket', async () => {
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '0';
      prisma.occasionReminder.findMany.mockResolvedValueOnce([
        candidate({ userId: 'user_anything' }),
      ]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      // Telemetry honesty: sample-percent rejection counts on its
      // own counter, NOT on the allowlist counter. Operators
      // monitoring rollout need to distinguish "the allowlist
      // excluded them" from "the percent bucket excluded them".
      expect(out.filteredSamplePercent).toBe(1);
      expect(out.filteredAllowlist).toBe(0);
      expect(out.fired).toBe(0);
    });

    it('reports filteredAllowlist (not sample) when an allowlist is configured', async () => {
      // With an allowlist set, rejection is allowlist-mode, even
      // if the sample percent would also exclude. The decision
      // resolver short-circuits on the allowlist before checking
      // the percent bucket.
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_other';
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '0';
      prisma.occasionReminder.findMany.mockResolvedValueOnce([
        candidate({ userId: 'user_anything' }),
      ]);
      const out = await worker.runOnce({
        now: new Date(Date.UTC(2026, 5, 8)),
      });
      expect(out.filteredAllowlist).toBe(1);
      expect(out.filteredSamplePercent).toBe(0);
    });
  });

  describe('orchestrator call shape', () => {
    beforeEach(enableFiring);

    it('passes the OccasionReminder category + link', async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([candidate()]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      await worker.runOnce({ now: new Date(Date.UTC(2026, 5, 8)) });
      const call = orchestrator.enqueue.mock.calls[0][0];
      expect(call.userId).toBe('user_1');
      expect(call.category).toBe(NotificationCategory.OccasionReminder);
      expect(call.type).toBe('occasion.reminder');
      expect(call.link).toBe('/occasions');
      // Body uses the owner's typed label.
      expect(call.body).toContain("Sarah's birthday");
    });

    it('falls back to translated kind when no label is set', async () => {
      prisma.occasionReminder.findMany.mockResolvedValueOnce([
        candidate({
          occasion: {
            id: 'occ_2',
            calendar: 'gregorian',
            year: null,
            month: 6,
            day: 15,
            recurrence: 'yearly',
            label: null,
            kind: 'birthday',
          },
        }),
      ]);
      prisma.reminderFiring.create.mockResolvedValueOnce({ id: 'rf_1' });
      await worker.runOnce({ now: new Date(Date.UTC(2026, 5, 8)) });
      const call = orchestrator.enqueue.mock.calls[0][0];
      // No identity leak — uses the generic "a birthday" phrase.
      expect(call.body).toContain('a birthday');
    });
  });

  describe('stale-claim observability (runOnce telemetry)', () => {
    beforeEach(enableFiring);

    it('reports staleClaims=0 when no stale rows exist (steady state)', async () => {
      prisma.reminderFiring.count.mockResolvedValueOnce(0);
      const out = await worker.runOnce({ now: new Date(Date.UTC(2026, 5, 8)) });
      expect(out.staleClaims).toBe(0);
    });

    it('surfaces a non-zero staleClaims count in the run stats', async () => {
      // Three rows have been stuck in 'claimed' state for >24h.
      // Should appear as an early-warning signal in the worker's
      // return value + log line WITHOUT mutating anything (the
      // cleanup endpoint is the only path that writes).
      prisma.reminderFiring.count.mockResolvedValueOnce(3);
      const out = await worker.runOnce({ now: new Date(Date.UTC(2026, 5, 8)) });
      expect(out.staleClaims).toBe(3);
      // CRITICAL: the count must not have triggered any mutation.
      expect(prisma.reminderFiring.updateMany).not.toHaveBeenCalled();
      expect(prisma.reminderFiring.deleteMany).not.toHaveBeenCalled();
    });

    it('passes a 24h-old threshold to the count query', async () => {
      const now = new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
      prisma.reminderFiring.count.mockResolvedValueOnce(0);
      await worker.runOnce({ now });
      const call = prisma.reminderFiring.count.mock.calls[0][0];
      expect(call.where.status).toBe('claimed');
      // firedAt threshold must be exactly 24h before now.
      const expected = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      expect(call.where.firedAt.lt).toEqual(expected);
    });

    it('continues the run if the count query throws', async () => {
      prisma.reminderFiring.count.mockRejectedValueOnce(
        new Error('telemetry db blip'),
      );
      const out = await worker.runOnce({ now: new Date(Date.UTC(2026, 5, 8)) });
      // Run still completed; stale count defaults to 0 on failure.
      expect(out.ran).toBe(true);
      expect(out.staleClaims).toBe(0);
    });
  });

  describe('cleanupStaleClaims — recovery for stuck "claimed" rows', () => {
    // The cleanup is the operator recovery path. The activation
    // flag does NOT gate it (it's a recovery action, not a fire),
    // but the dry-run default and forceClear opt-in safeguards
    // are in place to keep the surface safe.

    describe('safe default (mark-failed) mode', () => {
      it('defaults to dryRun=true and does NOT write', async () => {
        prisma.reminderFiring.findMany.mockResolvedValueOnce([
          { id: 'rf_stale_1' },
          { id: 'rf_stale_2' },
        ]);
        const out = await worker.cleanupStaleClaims({});
        expect(out.dryRun).toBe(true);
        expect(out.considered).toBe(2);
        expect(out.recovered).toBe(0);
        expect(out.cleared).toBe(0);
        // CRITICAL: no mutation in dry-run mode.
        expect(prisma.reminderFiring.updateMany).not.toHaveBeenCalled();
        expect(prisma.reminderFiring.deleteMany).not.toHaveBeenCalled();
      });

      it('transitions claimed → failed when dryRun=false', async () => {
        prisma.reminderFiring.findMany.mockResolvedValueOnce([
          { id: 'rf_stale_1' },
          { id: 'rf_stale_2' },
        ]);
        prisma.reminderFiring.updateMany.mockResolvedValueOnce({ count: 2 });
        const out = await worker.cleanupStaleClaims({ dryRun: false });
        expect(out.dryRun).toBe(false);
        expect(out.forceClear).toBe(false);
        expect(out.recovered).toBe(2);
        expect(out.cleared).toBe(0);
        // The update must:
        //   - target ONLY the discovered ids
        //   - re-assert `status: 'claimed'` for race safety (a
        //     concurrent legitimate update to 'sent' won't be
        //     clobbered)
        //   - set status='failed' + reason='stale_claim_recovered'
        const call = prisma.reminderFiring.updateMany.mock.calls[0][0];
        expect(call.where.id.in).toEqual(['rf_stale_1', 'rf_stale_2']);
        expect(call.where.status).toBe('claimed');
        expect(call.data).toEqual({
          status: 'failed',
          reason: 'stale_claim_recovered',
        });
      });

      it('preserves the idempotency anchor — no delete, key still held', async () => {
        // The PURPOSE of mark-failed (vs force-clear) is to keep
        // the unique constraint engaged. We assert deleteMany is
        // never called in the safe path.
        prisma.reminderFiring.findMany.mockResolvedValueOnce([
          { id: 'rf_stale_1' },
        ]);
        prisma.reminderFiring.updateMany.mockResolvedValueOnce({ count: 1 });
        await worker.cleanupStaleClaims({ dryRun: false });
        expect(prisma.reminderFiring.deleteMany).not.toHaveBeenCalled();
      });
    });

    describe('destructive opt-in (force-clear) mode', () => {
      it('requires BOTH dryRun=false AND forceClear=true to delete', async () => {
        prisma.reminderFiring.findMany.mockResolvedValueOnce([
          { id: 'rf_stale_1' },
        ]);
        // forceClear=true but dryRun still default true → no write.
        const out = await worker.cleanupStaleClaims({ forceClear: true });
        expect(out.dryRun).toBe(true);
        expect(out.forceClear).toBe(true);
        expect(out.cleared).toBe(0);
        expect(prisma.reminderFiring.deleteMany).not.toHaveBeenCalled();
      });

      it('deletes when dryRun=false AND forceClear=true', async () => {
        prisma.reminderFiring.findMany.mockResolvedValueOnce([
          { id: 'rf_stale_1' },
          { id: 'rf_stale_2' },
        ]);
        prisma.reminderFiring.deleteMany.mockResolvedValueOnce({ count: 2 });
        const out = await worker.cleanupStaleClaims({
          dryRun: false,
          forceClear: true,
        });
        expect(out.cleared).toBe(2);
        expect(out.recovered).toBe(0);
        // updateMany must NOT be called in force-clear mode.
        expect(prisma.reminderFiring.updateMany).not.toHaveBeenCalled();
        const call = prisma.reminderFiring.deleteMany.mock.calls[0][0];
        // Same race-safe predicate as mark-failed.
        expect(call.where.id.in).toEqual(['rf_stale_1', 'rf_stale_2']);
        expect(call.where.status).toBe('claimed');
      });
    });

    describe('scan window + safety rails', () => {
      it('clamps staleHoursOld to [1, 720]', async () => {
        prisma.reminderFiring.findMany.mockResolvedValue([]);

        await worker.cleanupStaleClaims({
          staleHoursOld: -5,
          now: new Date(Date.UTC(2026, 5, 8, 0, 0, 0)),
        });
        const lowerCall = prisma.reminderFiring.findMany.mock.calls[0][0];
        // Lower bound clamp = 1 hour.
        expect(lowerCall.where.firedAt.lt).toEqual(
          new Date(Date.UTC(2026, 5, 7, 23, 0, 0)),
        );

        await worker.cleanupStaleClaims({
          staleHoursOld: 99999,
          now: new Date(Date.UTC(2026, 5, 8, 0, 0, 0)),
        });
        const upperCall = prisma.reminderFiring.findMany.mock.calls[1][0];
        // Upper bound clamp = 720 hours (30 days).
        expect(upperCall.where.firedAt.lt).toEqual(
          new Date(Date.UTC(2026, 4, 9, 0, 0, 0)),
        );
      });

      it('returns considered=0 + zero counts when no stale rows exist', async () => {
        prisma.reminderFiring.findMany.mockResolvedValueOnce([]);
        const out = await worker.cleanupStaleClaims({ dryRun: false });
        expect(out.considered).toBe(0);
        expect(out.recovered).toBe(0);
        expect(out.cleared).toBe(0);
        expect(out.errors).toBe(0);
        expect(out.sampleIds).toEqual([]);
        // Must NOT call updateMany/deleteMany when there's nothing
        // to do.
        expect(prisma.reminderFiring.updateMany).not.toHaveBeenCalled();
        expect(prisma.reminderFiring.deleteMany).not.toHaveBeenCalled();
      });

      it('surfaces up to 10 row ids as sampleIds for operator inspection', async () => {
        const fifteenIds = Array.from({ length: 15 }, (_, i) => ({
          id: `rf_${i}`,
        }));
        prisma.reminderFiring.findMany.mockResolvedValueOnce(fifteenIds);
        const out = await worker.cleanupStaleClaims({});
        expect(out.considered).toBe(15);
        expect(out.sampleIds).toHaveLength(10);
        expect(out.sampleIds[0]).toBe('rf_0');
      });

      it('counts errors when the update fails', async () => {
        prisma.reminderFiring.findMany.mockResolvedValueOnce([
          { id: 'rf_stale_1' },
        ]);
        prisma.reminderFiring.updateMany.mockRejectedValueOnce(
          new Error('db down'),
        );
        const out = await worker.cleanupStaleClaims({ dryRun: false });
        expect(out.errors).toBe(1);
        expect(out.recovered).toBe(0);
      });

      it('counts errors when the scan fails', async () => {
        prisma.reminderFiring.findMany.mockRejectedValueOnce(
          new Error('scan blew up'),
        );
        const out = await worker.cleanupStaleClaims({ dryRun: false });
        expect(out.errors).toBe(1);
        expect(out.considered).toBe(0);
      });
    });
  });
});
