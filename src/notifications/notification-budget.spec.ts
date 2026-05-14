// Tests for the pure budget engine. The engine is a decision
// table — these specs lock down each branch so a future refactor
// can't accidentally change priorities.

import { evaluateBudget, type BudgetInputs } from './notification-budget';
import { NotificationCategory, descriptorFor } from './notification-categories';

// Helper — build an input shape with sensible defaults; tests
// override only what they care about.
const inputs = (overrides: Partial<BudgetInputs> = {}): BudgetInputs => ({
  category: NotificationCategory.GiftUpdate,
  descriptor: descriptorFor(NotificationCategory.GiftUpdate),
  dailyCount: 0,
  weeklyCount: 0,
  optedOut: false,
  inQuietHours: false,
  digestEnabled: true,
  ...overrides,
});

describe('evaluateBudget', () => {
  describe('mandatory categories bypass every gate', () => {
    for (const id of [
      NotificationCategory.Security,
      NotificationCategory.Otp,
      NotificationCategory.Legal,
    ]) {
      it(`${id} sends real-time even when every gate would block`, () => {
        const out = evaluateBudget(
          inputs({
            category: id,
            descriptor: descriptorFor(id),
            // Every gate set to "would block":
            optedOut: true,
            dailyCount: 9999,
            weeklyCount: 9999,
            inQuietHours: true,
            digestEnabled: true,
          }),
        );
        expect(out.kind).toBe('send_realtime');
      });
    }
  });

  describe('opt-out (optional categories)', () => {
    it('suppresses when user opted out', () => {
      const out = evaluateBudget(inputs({ optedOut: true }));
      expect(out).toEqual({ kind: 'suppress', reason: 'user_opted_out' });
    });

    it('opt-out wins over every other gate', () => {
      // Opt-out is the first non-mandatory check. Even if the
      // user is NOT in quiet hours and well under budget, an
      // opt-out suppresses.
      const out = evaluateBudget(
        inputs({
          optedOut: true,
          dailyCount: 0,
          weeklyCount: 0,
          inQuietHours: false,
        }),
      );
      expect(out).toEqual({ kind: 'suppress', reason: 'user_opted_out' });
    });
  });

  describe('daily cap', () => {
    const descriptor = descriptorFor(NotificationCategory.GiftUpdate);

    it('queues for digest when dailyCount equals cap', () => {
      const out = evaluateBudget(
        inputs({
          dailyCount: descriptor.dailyCap as number,
        }),
      );
      expect(out).toEqual({
        kind: 'queue_digest',
        reason: 'daily_cap_exceeded',
      });
    });

    it('queues for digest when dailyCount exceeds cap', () => {
      const out = evaluateBudget(
        inputs({
          dailyCount: (descriptor.dailyCap as number) + 50,
        }),
      );
      expect(out).toEqual({
        kind: 'queue_digest',
        reason: 'daily_cap_exceeded',
      });
    });

    it('sends real-time when under cap', () => {
      const out = evaluateBudget(
        inputs({
          dailyCount: (descriptor.dailyCap as number) - 1,
        }),
      );
      expect(out.kind).toBe('send_realtime');
    });
  });

  describe('weekly cap', () => {
    const descriptor = descriptorFor(NotificationCategory.GiftUpdate);

    it('queues for digest when weeklyCount equals cap', () => {
      const out = evaluateBudget(
        inputs({
          weeklyCount: descriptor.weeklyCap as number,
        }),
      );
      expect(out).toEqual({
        kind: 'queue_digest',
        reason: 'weekly_cap_exceeded',
      });
    });

    it('daily-cap check fires BEFORE weekly-cap when both exceeded', () => {
      // Order matters for the reason string — daily is the more
      // immediately-useful telemetry signal. This locks the order.
      const out = evaluateBudget(
        inputs({
          dailyCount: 9999,
          weeklyCount: 9999,
        }),
      );
      expect(out).toEqual({
        kind: 'queue_digest',
        reason: 'daily_cap_exceeded',
      });
    });
  });

  describe('quiet hours', () => {
    it('queues for digest when in quiet hours', () => {
      const out = evaluateBudget(inputs({ inQuietHours: true }));
      expect(out).toEqual({
        kind: 'queue_digest',
        reason: 'quiet_hours',
      });
    });

    it('budget caps fire BEFORE quiet hours (more specific reason wins)', () => {
      // If the user is BOTH over budget AND in quiet hours, we
      // report the budget reason — it's the more actionable
      // signal for telemetry.
      const out = evaluateBudget(
        inputs({
          dailyCount: 9999,
          inQuietHours: true,
        }),
      );
      expect(out).toEqual({
        kind: 'queue_digest',
        reason: 'daily_cap_exceeded',
      });
    });
  });

  describe('digestEnabled (master switch)', () => {
    it('sends real-time when digestEnabled is false and under caps', () => {
      // Power-user mode — they want every event immediately and
      // accept the trade-off.
      const out = evaluateBudget(
        inputs({
          digestEnabled: false,
        }),
      );
      expect(out.kind).toBe('send_realtime');
    });

    it('digestEnabled=false does NOT bypass quiet hours', () => {
      // Quiet hours are a hard preference — explicit user
      // intent to not be disturbed. The master switch doesn't
      // override that.
      const out = evaluateBudget(
        inputs({
          digestEnabled: false,
          inQuietHours: true,
        }),
      );
      expect(out).toEqual({
        kind: 'queue_digest',
        reason: 'quiet_hours',
      });
    });
  });

  describe('happy path', () => {
    it('sends real-time when no gate fires', () => {
      const out = evaluateBudget(inputs());
      expect(out).toEqual({ kind: 'send_realtime' });
    });
  });
});
