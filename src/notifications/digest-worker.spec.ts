// Tests for the DigestWorker. Locks down:
//   1. Feature-flag gating (default OFF)
//   2. Idempotent row stamping (updateMany with null predicate)
//   3. Calm body composition (counts only — no per-row content)
//   4. Cadence (daily fires every run, weekly only on UTC Monday)
//   5. Real-time users (digestEnabled=false) get rows stamped
//      without a summary push
//   6. Race-loss case (another worker stamped first → no push)

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { DigestWorker, _testables } from './digest-worker.service';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationCategory } from './notification-categories';

const ENV_KEYS = ['QIFT_DIGEST_WORKER_ENABLED', 'QIFT_REMINDER_DRY_RUN'];
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function enableDigest() {
  process.env.QIFT_DIGEST_WORKER_ENABLED = 'true';
}

type MockPrisma = {
  notification: { findMany: jest.Mock; updateMany: jest.Mock };
  notificationPreferences: { findUnique: jest.Mock };
};

function createPrismaMock(): MockPrisma {
  return {
    notification: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    notificationPreferences: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

// Use a Monday so the daily-vs-weekly cadence cases stay
// deterministic in tests that don't override.
const MONDAY_NOON_UTC = new Date(Date.UTC(2026, 4, 18, 12, 0, 0));
const TUESDAY_NOON_UTC = new Date(Date.UTC(2026, 4, 19, 12, 0, 0));

describe('DigestWorker', () => {
  let worker: DigestWorker;
  let prisma: MockPrisma;
  let orchestrator: { enqueue: jest.Mock };

  beforeEach(async () => {
    clearEnv();
    prisma = createPrismaMock();
    orchestrator = {
      enqueue: jest.fn().mockResolvedValue({
        kind: 'sent',
        notificationId: 'sum_1',
        category: 'system',
        pushed: true,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DigestWorker,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationOrchestrator, useValue: orchestrator },
      ],
    }).compile();
    worker = module.get<DigestWorker>(DigestWorker);
  });
  afterAll(clearEnv);

  describe('feature-flag gating', () => {
    it('skips entirely when QIFT_DIGEST_WORKER_ENABLED is off', async () => {
      const out = await worker.runOnce({ now: TUESDAY_NOON_UTC });
      expect(out.ran).toBe(false);
      expect(out.skippedReason).toBe('feature_flag_off');
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
    });
    it('runs when flag is on', async () => {
      enableDigest();
      const out = await worker.runOnce({ now: TUESDAY_NOON_UTC });
      expect(out.ran).toBe(true);
    });
    it('forceDryRun bypasses the activation flag', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      const out = await worker.runOnce({
        now: TUESDAY_NOON_UTC,
        forceDryRun: true,
      });
      expect(out.ran).toBe(true);
      expect(out.filteredDryRun).toBe(1);
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('cadence gate', () => {
    beforeEach(enableDigest);

    it('daily users process every run', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'daily',
        digestEnabled: true,
      });
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
      const out = await worker.runOnce({ now: TUESDAY_NOON_UTC });
      expect(out.usersDigested).toBe(1);
      expect(out.rowsConsumed).toBe(1);
    });

    it('weekly users are filtered on non-Monday', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'weekly',
        digestEnabled: true,
      });
      const out = await worker.runOnce({ now: TUESDAY_NOON_UTC });
      expect(out.filteredCadence).toBe(1);
      expect(out.usersDigested).toBe(0);
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });

    it('weekly users process on Monday', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'weekly',
        digestEnabled: true,
      });
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
      const out = await worker.runOnce({ now: MONDAY_NOON_UTC });
      expect(out.usersDigested).toBe(1);
    });

    it('cadenceOverride forces processing regardless of stored frequency', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'weekly',
        digestEnabled: true,
      });
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
      const out = await worker.runOnce({
        now: TUESDAY_NOON_UTC, // not Monday
        cadenceOverride: 'force_daily',
      });
      expect(out.usersDigested).toBe(1);
    });
  });

  describe('digestEnabled=false (real-time user)', () => {
    beforeEach(enableDigest);

    it('stamps queued rows without sending a summary push', async () => {
      // If a real-time user has queued rows (race during preference
      // toggle), we stamp them as delivered without firing a
      // summary push — avoids surprise digest for a user who
      // explicitly opted out of digests.
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
        { id: 'n_2', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'daily',
        digestEnabled: false,
      });
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 2 });
      const out = await worker.runOnce({ now: TUESDAY_NOON_UTC });
      expect(out.rowsConsumed).toBe(2);
      expect(out.usersDigested).toBe(0);
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('idempotency (race safety)', () => {
    beforeEach(enableDigest);

    it('uses updateMany with pushDeliveredAt:null predicate for race-safe stamping', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'daily',
        digestEnabled: true,
      });
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
      await worker.runOnce({ now: TUESDAY_NOON_UTC });
      const call = prisma.notification.updateMany.mock.calls[0][0];
      expect(call.where.id.in).toEqual(['n_1']);
      // The race-safe predicate. A concurrent worker run on the
      // same row finds zero matches if we already stamped.
      expect(call.where.pushDeliveredAt).toBeNull();
    });

    it('skips push when another worker already stamped (race-loss)', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'daily',
        digestEnabled: true,
      });
      // updateMany found 0 matches → another run beat us.
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });
      const out = await worker.runOnce({ now: TUESDAY_NOON_UTC });
      expect(out.rowsConsumed).toBe(0);
      expect(out.usersDigested).toBe(0);
      expect(orchestrator.enqueue).not.toHaveBeenCalled();
    });

    it('stamps BEFORE pushing — push failure does not leave dangling unstamped rows', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'daily',
        digestEnabled: true,
      });
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
      orchestrator.enqueue.mockRejectedValueOnce(
        new Error('push gateway down'),
      );
      const out = await worker.runOnce({ now: TUESDAY_NOON_UTC });
      // Rows are stamped; the user reads from the in-app inbox.
      // We trade "missing summary push" for "no duplicate push" —
      // the right call.
      expect(out.rowsConsumed).toBe(1);
      expect(out.errors).toBe(1);
    });
  });

  describe('recursion guard — digest.summary rows do not feed the next run', () => {
    beforeEach(enableDigest);

    it('excludes type=digest.summary from the pending query (predicate level)', async () => {
      // The recursion concern: the digest worker's own summary
      // is written via the orchestrator with type='digest.summary'
      // and category='system'. If the user has hit the System
      // category daily cap, the orchestrator queues the summary
      // itself (pushDeliveredAt=null). Without a filter at the
      // worker's findMany, that queued summary would be picked up
      // on the next run and bundled into ANOTHER summary, which
      // could itself queue, and so on. The filter breaks the
      // loop.
      prisma.notification.findMany.mockResolvedValueOnce([]);
      await worker.runOnce({ now: TUESDAY_NOON_UTC });
      const call = prisma.notification.findMany.mock.calls[0][0];
      // The where predicate must include the type exclusion.
      // We intentionally assert on the exact shape so a future
      // refactor that drops the filter is caught by this spec.
      expect(call.where).toMatchObject({
        pushDeliveredAt: null,
        type: { not: 'digest.summary' },
      });
    });
  });

  describe('orchestrator call shape', () => {
    beforeEach(enableDigest);

    it('summary uses category=system and calm body copy', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([
        { id: 'n_1', userId: 'user_1', category: 'gift_update' },
        { id: 'n_2', userId: 'user_1', category: 'gift_update' },
        { id: 'n_3', userId: 'user_1', category: 'occasion_reminder' },
      ]);
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        digestFrequency: 'daily',
        digestEnabled: true,
      });
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 3 });
      await worker.runOnce({ now: TUESDAY_NOON_UTC });
      const call = orchestrator.enqueue.mock.calls[0][0];
      expect(call.userId).toBe('user_1');
      expect(call.category).toBe(NotificationCategory.System);
      expect(call.type).toBe('digest.summary');
      expect(call.title).toBe('Quiet update');
      expect(call.link).toBe('/notifications');
      // Body counts per category — never per-row content.
      expect(call.body).toContain('2 gift updates');
      expect(call.body).toContain('1 occasion reminder');
    });
  });
});

// ── Pure-helper specs ───────────────────────────────────────────

describe('digest body composition (pure)', () => {
  const {
    composeDigestBody,
    summariseCategories,
    isDueForDigest,
    humanPlural,
  } = _testables;

  describe('summariseCategories', () => {
    it('counts per category and sorts alphabetically', () => {
      const out = summariseCategories([
        { category: 'gift_update' },
        { category: 'social' },
        { category: 'gift_update' },
        { category: 'occasion_reminder' },
        { category: 'gift_update' },
      ]);
      expect(out).toEqual([
        ['gift_update', 3],
        ['occasion_reminder', 1],
        ['social', 1],
      ]);
    });
    it('null category buckets under "other"', () => {
      const out = summariseCategories([{ category: null }, { category: null }]);
      expect(out).toEqual([['other', 2]]);
    });
  });

  describe('composeDigestBody', () => {
    it('renders a single category as "N x since you last checked"', () => {
      expect(composeDigestBody([['gift_update', 1]])).toBe(
        '1 gift update since you last checked.',
      );
      expect(composeDigestBody([['gift_update', 5]])).toBe(
        '5 gift updates since you last checked.',
      );
    });
    it('joins multiple categories with comma + "and"', () => {
      const body = composeDigestBody([
        ['gift_update', 2],
        ['occasion_reminder', 1],
        ['social', 3],
      ]);
      // Calm body — no urgency, no exclamation marks.
      expect(body).toContain('2 gift updates');
      expect(body).toContain('1 occasion reminder');
      expect(body).toContain('3 appreciations');
      expect(body).toContain('since you last checked');
      // Should not contain pressure language.
      expect(body).not.toContain('!');
      expect(body).not.toContain('missed');
      expect(body).not.toContain('unread');
    });
  });

  describe('isDueForDigest', () => {
    it('daily users are always due', () => {
      // Same date as Monday/Tuesday in the suite above.
      expect(isDueForDigest('daily', MONDAY_NOON_UTC)).toBe(true);
      expect(isDueForDigest('daily', TUESDAY_NOON_UTC)).toBe(true);
    });
    it('weekly users due only on Monday UTC', () => {
      expect(isDueForDigest('weekly', MONDAY_NOON_UTC)).toBe(true);
      expect(isDueForDigest('weekly', TUESDAY_NOON_UTC)).toBe(false);
    });
  });

  describe('humanPlural', () => {
    it('produces singular vs plural forms', () => {
      expect(humanPlural('gift_update', 1)).toBe('gift update');
      expect(humanPlural('gift_update', 5)).toBe('gift updates');
      expect(humanPlural('social', 1)).toBe('appreciation');
      expect(humanPlural('social', 2)).toBe('appreciations');
    });
    it('unknown category falls back to "update(s)"', () => {
      expect(humanPlural('unknown_cat', 1)).toBe('update');
      expect(humanPlural('unknown_cat', 7)).toBe('updates');
    });
  });
});
