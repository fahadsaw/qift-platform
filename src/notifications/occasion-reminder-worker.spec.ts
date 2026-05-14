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
  };
};

function createPrismaMock(): MockPrisma {
  return {
    occasionReminder: { findMany: jest.fn().mockResolvedValue([]) },
    reminderFiring: {
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
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
      expect(out.filteredAllowlist).toBe(1); // shared counter
      expect(out.fired).toBe(0);
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
});
