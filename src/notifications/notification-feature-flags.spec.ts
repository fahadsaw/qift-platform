// Tests for the Phase 7.2 feature flag helpers. The flags drive
// activation, rollout shape, and the global push kill switch —
// every helper is small but architecturally load-bearing, so
// each one gets a focused spec.

import {
  isDigestWorkerEnabled,
  isEmailDeliveryEnabled,
  isOccasionReminderFiringEnabled,
  isPushDeliveryEnabled,
  isReminderDryRun,
  isSmsDeliveryEnabled,
  reminderAllowlist,
  reminderProcessDecision,
  reminderUserSamplePercent,
  shouldProcessUserForReminders,
} from './notification-feature-flags';

const ENV_KEYS = [
  'QIFT_OCCASION_REMINDER_FIRING_ENABLED',
  'QIFT_DIGEST_WORKER_ENABLED',
  'QIFT_PUSH_DELIVERY_ENABLED',
  'QIFT_EMAIL_DELIVERY_ENABLED',
  'QIFT_SMS_DELIVERY_ENABLED',
  'QIFT_REMINDER_DRY_RUN',
  'QIFT_REMINDER_ALLOWLIST',
  'QIFT_REMINDER_USER_SAMPLE_PERCENT',
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('notification feature flags', () => {
  beforeEach(clearEnv);
  afterAll(clearEnv);

  describe('activation flags — default-deny', () => {
    it('isOccasionReminderFiringEnabled defaults false', () => {
      expect(isOccasionReminderFiringEnabled()).toBe(false);
    });
    it('isDigestWorkerEnabled defaults false', () => {
      expect(isDigestWorkerEnabled()).toBe(false);
    });
    it('isEmailDeliveryEnabled defaults false', () => {
      expect(isEmailDeliveryEnabled()).toBe(false);
    });
    it('isSmsDeliveryEnabled defaults false', () => {
      expect(isSmsDeliveryEnabled()).toBe(false);
    });

    it('only the literal "true" string flips a flag on', () => {
      // Default-deny against typos: '1', 'yes', 'TRUE' do not
      // activate. Operator must explicitly set 'true'.
      process.env.QIFT_OCCASION_REMINDER_FIRING_ENABLED = '1';
      expect(isOccasionReminderFiringEnabled()).toBe(false);
      process.env.QIFT_OCCASION_REMINDER_FIRING_ENABLED = 'yes';
      expect(isOccasionReminderFiringEnabled()).toBe(false);
      process.env.QIFT_OCCASION_REMINDER_FIRING_ENABLED = 'TRUE';
      expect(isOccasionReminderFiringEnabled()).toBe(false);
      process.env.QIFT_OCCASION_REMINDER_FIRING_ENABLED = 'true';
      expect(isOccasionReminderFiringEnabled()).toBe(true);
    });
  });

  describe('isPushDeliveryEnabled — inverted (default ON)', () => {
    // Architectural exception: push has been live since the gift
    // flow shipped. Defaulting OFF would regress existing
    // notifications. The flag is an emergency kill switch.
    it('defaults true when env var unset', () => {
      expect(isPushDeliveryEnabled()).toBe(true);
    });
    it('explicit "false" disables', () => {
      process.env.QIFT_PUSH_DELIVERY_ENABLED = 'false';
      expect(isPushDeliveryEnabled()).toBe(false);
    });
    it('anything other than "false" keeps it on', () => {
      process.env.QIFT_PUSH_DELIVERY_ENABLED = 'true';
      expect(isPushDeliveryEnabled()).toBe(true);
      process.env.QIFT_PUSH_DELIVERY_ENABLED = 'yes';
      expect(isPushDeliveryEnabled()).toBe(true);
      process.env.QIFT_PUSH_DELIVERY_ENABLED = '';
      expect(isPushDeliveryEnabled()).toBe(true);
    });
  });

  describe('rollout shape — dry-run', () => {
    it('defaults false', () => {
      expect(isReminderDryRun()).toBe(false);
    });
    it('flips on with explicit "true"', () => {
      process.env.QIFT_REMINDER_DRY_RUN = 'true';
      expect(isReminderDryRun()).toBe(true);
    });
  });

  describe('reminderAllowlist parsing', () => {
    it('returns [] when env var is unset', () => {
      expect(reminderAllowlist()).toEqual([]);
    });
    it('returns [] for whitespace-only', () => {
      process.env.QIFT_REMINDER_ALLOWLIST = '   ';
      expect(reminderAllowlist()).toEqual([]);
    });
    it('splits a single id', () => {
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_1';
      expect(reminderAllowlist()).toEqual(['user_1']);
    });
    it('splits multiple ids and trims whitespace', () => {
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_1, user_2 ,user_3';
      expect(reminderAllowlist()).toEqual(['user_1', 'user_2', 'user_3']);
    });
    it('filters empty entries', () => {
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_1,,user_2,';
      expect(reminderAllowlist()).toEqual(['user_1', 'user_2']);
    });
  });

  describe('reminderUserSamplePercent', () => {
    it('defaults to 100 when unset', () => {
      expect(reminderUserSamplePercent()).toBe(100);
    });
    it('clamps to 0..100', () => {
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '-5';
      expect(reminderUserSamplePercent()).toBe(0);
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '150';
      expect(reminderUserSamplePercent()).toBe(100);
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '37';
      expect(reminderUserSamplePercent()).toBe(37);
    });
    it('falls back to 100 on malformed input', () => {
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = 'half';
      expect(reminderUserSamplePercent()).toBe(100);
    });
  });

  describe('shouldProcessUserForReminders', () => {
    it('returns true when no allowlist + 100% sample (defaults)', () => {
      expect(shouldProcessUserForReminders('user_1')).toBe(true);
    });

    describe('allowlist mode', () => {
      it('returns true only for allowlisted users', () => {
        process.env.QIFT_REMINDER_ALLOWLIST = 'user_1, user_2';
        expect(shouldProcessUserForReminders('user_1')).toBe(true);
        expect(shouldProcessUserForReminders('user_2')).toBe(true);
        expect(shouldProcessUserForReminders('user_3')).toBe(false);
      });
      it('allowlist OVERRIDES sample percent', () => {
        // With both set, allowlist wins — only listed users
        // process regardless of percent bucket.
        process.env.QIFT_REMINDER_ALLOWLIST = 'user_1';
        process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '100';
        expect(shouldProcessUserForReminders('user_2')).toBe(false);
      });
    });

    describe('sample percent mode', () => {
      it('returns false for everyone at 0%', () => {
        process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '0';
        expect(shouldProcessUserForReminders('user_1')).toBe(false);
        expect(shouldProcessUserForReminders('user_999')).toBe(false);
      });
      it('returns true for everyone at 100%', () => {
        process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '100';
        expect(shouldProcessUserForReminders('user_1')).toBe(true);
        expect(shouldProcessUserForReminders('user_999')).toBe(true);
      });
      it('bucketing is stable — same id always returns same decision', () => {
        // The percentile hash is deterministic; this is the load-
        // bearing rollout-shape guarantee. A user doesn't flip
        // in/out of eligibility between runs.
        process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '50';
        const a1 = shouldProcessUserForReminders('user_stable_a');
        const a2 = shouldProcessUserForReminders('user_stable_a');
        const a3 = shouldProcessUserForReminders('user_stable_a');
        expect(a1).toBe(a2);
        expect(a2).toBe(a3);
      });
      it('different ids produce a mix of in/out decisions', () => {
        // Crude distribution check — at 50%, across 200 distinct
        // ids, we should see both true + false outcomes (the
        // FNV-1a hash mixes well enough for this assertion).
        process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '50';
        let trues = 0;
        let falses = 0;
        for (let i = 0; i < 200; i += 1) {
          if (shouldProcessUserForReminders(`user_${i}`)) trues += 1;
          else falses += 1;
        }
        expect(trues).toBeGreaterThan(0);
        expect(falses).toBeGreaterThan(0);
      });
    });
  });

  describe('reminderProcessDecision (telemetry-honest variant)', () => {
    // The richer return shape lets the reminder worker keep
    // separate counters for allowlist-rejection vs sample-percent-
    // rejection. The boolean wrapper above stays the convenient
    // form; this is the cause-tagged form.

    it('returns kind=process when no gates exclude the user', () => {
      expect(reminderProcessDecision('user_1')).toEqual({ kind: 'process' });
    });

    it('returns kind=reject_allowlist when allowlist excludes', () => {
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_other';
      expect(reminderProcessDecision('user_anything')).toEqual({
        kind: 'reject_allowlist',
      });
    });

    it('returns kind=process for allowlisted users', () => {
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_1';
      expect(reminderProcessDecision('user_1')).toEqual({ kind: 'process' });
    });

    it('returns kind=reject_sample_percent when no allowlist + 0%', () => {
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '0';
      expect(reminderProcessDecision('user_anything')).toEqual({
        kind: 'reject_sample_percent',
      });
    });

    it('allowlist short-circuits BEFORE sample-percent', () => {
      // If both are set, the allowlist is the authoritative gate
      // and the rejection cause is allowlist (even though the
      // sample percent would also reject).
      process.env.QIFT_REMINDER_ALLOWLIST = 'user_other';
      process.env.QIFT_REMINDER_USER_SAMPLE_PERCENT = '0';
      expect(reminderProcessDecision('user_anything')).toEqual({
        kind: 'reject_allowlist',
      });
    });
  });
});
