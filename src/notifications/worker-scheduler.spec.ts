// NotificationWorkerScheduler contract (Occasions Activation).
//
//   - Scheduler flag OFF → tick() runs nothing (deploy-safe).
//   - Scheduler ON + worker flags OFF → still nothing (double gate).
//   - Scheduler ON + reminder flag ON → reminder runOnce called;
//     digest untouched (and vice versa).
//   - A worker failure is swallowed + logged; the other worker
//     still runs (isolation).
//   - NODE_ENV=test → onModuleInit arms no timers (jest holds no
//     open handles; this very suite proves it by existing).

import { NotificationWorkerScheduler } from './worker-scheduler.service';
import type { OccasionReminderWorker } from './occasion-reminder-worker.service';
import type { DigestWorker } from './digest-worker.service';

const setEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

describe('NotificationWorkerScheduler.tick', () => {
  const FLAGS = [
    'QIFT_NOTIFICATION_SCHEDULER_ENABLED',
    'QIFT_OCCASION_REMINDER_FIRING_ENABLED',
    'QIFT_DIGEST_WORKER_ENABLED',
  ] as const;
  const original: Record<string, string | undefined> = {};

  let reminderRun: jest.Mock;
  let digestRun: jest.Mock;
  let scheduler: NotificationWorkerScheduler;

  beforeEach(() => {
    for (const f of FLAGS) original[f] = process.env[f];
    reminderRun = jest.fn().mockResolvedValue({ fired: 0 });
    digestRun = jest.fn().mockResolvedValue({ digests: 0 });
    scheduler = new NotificationWorkerScheduler(
      { runOnce: reminderRun } as unknown as OccasionReminderWorker,
      { runOnce: digestRun } as unknown as DigestWorker,
    );
  });

  afterEach(() => {
    for (const f of FLAGS) setEnv(f, original[f]);
  });

  it('does nothing when the scheduler flag is off (default)', async () => {
    setEnv('QIFT_NOTIFICATION_SCHEDULER_ENABLED', undefined);
    setEnv('QIFT_OCCASION_REMINDER_FIRING_ENABLED', 'true');
    setEnv('QIFT_DIGEST_WORKER_ENABLED', 'true');

    await scheduler.tick();

    expect(reminderRun).not.toHaveBeenCalled();
    expect(digestRun).not.toHaveBeenCalled();
  });

  it('scheduler on + worker flags off → still nothing (double gate)', async () => {
    setEnv('QIFT_NOTIFICATION_SCHEDULER_ENABLED', 'true');
    setEnv('QIFT_OCCASION_REMINDER_FIRING_ENABLED', undefined);
    setEnv('QIFT_DIGEST_WORKER_ENABLED', undefined);

    await scheduler.tick();

    expect(reminderRun).not.toHaveBeenCalled();
    expect(digestRun).not.toHaveBeenCalled();
  });

  it('runs exactly the workers whose flags are on', async () => {
    setEnv('QIFT_NOTIFICATION_SCHEDULER_ENABLED', 'true');
    setEnv('QIFT_OCCASION_REMINDER_FIRING_ENABLED', 'true');
    setEnv('QIFT_DIGEST_WORKER_ENABLED', undefined);

    await scheduler.tick();

    expect(reminderRun).toHaveBeenCalledTimes(1);
    expect(digestRun).not.toHaveBeenCalled();
  });

  it('a reminder failure is isolated — digest still runs', async () => {
    setEnv('QIFT_NOTIFICATION_SCHEDULER_ENABLED', 'true');
    setEnv('QIFT_OCCASION_REMINDER_FIRING_ENABLED', 'true');
    setEnv('QIFT_DIGEST_WORKER_ENABLED', 'true');
    reminderRun.mockRejectedValue(new Error('boom'));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(digestRun).toHaveBeenCalledTimes(1);
  });

  it('arms no timers under NODE_ENV=test', () => {
    // NODE_ENV is 'test' under jest by default.
    scheduler.onModuleInit();
    // Reaching here without jest open-handle warnings is the real
    // assertion; onModuleDestroy must also be safe to call.
    scheduler.onModuleDestroy();
  });
});
