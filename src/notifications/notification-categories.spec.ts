// Tests for the static category registry. The registry is
// architectural truth — these specs lock down the matrix so a
// careless future edit can't accidentally:
//   - turn off the mandatory flag on a security category
//   - make every category mandatory (silencing the user)
//   - leave a NotificationType without a category mapping
//   - put marketing-class categories on the SMS channel

import {
  NotificationCategory,
  categoryForType,
  descriptorFor,
  isMandatory,
  listCategories,
} from './notification-categories';
import { NotificationType } from './notifications.service';

describe('NotificationCategory registry', () => {
  describe('mandatory invariants', () => {
    it('Security, Otp, and Legal are the ONLY mandatory categories', () => {
      const mandatoryIds = listCategories()
        .filter(({ descriptor }) => descriptor.mandatory)
        .map(({ id }) => id)
        .sort();
      // Locking down the exact list — adding a new mandatory
      // category requires deliberately updating this test.
      expect(mandatoryIds).toEqual(
        [
          NotificationCategory.Legal,
          NotificationCategory.Otp,
          NotificationCategory.Security,
        ].sort(),
      );
    });

    it('every mandatory category has dailyCap=null and weeklyCap=null', () => {
      // Mandatory categories must NOT be silenced by budget. The
      // null caps signal "no limit" to the budget engine.
      for (const { descriptor } of listCategories()) {
        if (descriptor.mandatory) {
          expect(descriptor.dailyCap).toBeNull();
          expect(descriptor.weeklyCap).toBeNull();
        }
      }
    });

    it('every non-mandatory category has FINITE daily + weekly caps', () => {
      // Optional categories MUST be cappable — a runaway producer
      // can't flood the user. This is the calm-UX invariant.
      for (const { descriptor } of listCategories()) {
        if (!descriptor.mandatory) {
          expect(descriptor.dailyCap).toBeGreaterThan(0);
          expect(descriptor.weeklyCap).toBeGreaterThan(0);
          // Weekly must be >= daily; otherwise the daily cap is
          // unreachable.
          expect(descriptor.weeklyCap).toBeGreaterThanOrEqual(
            descriptor.dailyCap ?? 0,
          );
        }
      }
    });

    it('OTP is the only category limited to SMS + email channels', () => {
      // Push / in-app are useless for OTP (user is logged out).
      // Locking this so a regression doesn't quietly add in-app
      // to OTP and make the OTP flow appear in the bell.
      const otp = descriptorFor(NotificationCategory.Otp);
      expect(otp.eligibleChannels).toEqual(
        expect.arrayContaining(['sms', 'email']),
      );
      expect(otp.eligibleChannels).not.toContain('in_app');
      expect(otp.eligibleChannels).not.toContain('push');
    });

    it('Social category does NOT have email or SMS channels', () => {
      // The social ping (👍 on a gift post) is push-or-bell only.
      // Marketing-class delivery surfaces must NOT include the
      // high-cost / privacy-sensitive channels.
      const social = descriptorFor(NotificationCategory.Social);
      expect(social.eligibleChannels).toContain('in_app');
      expect(social.eligibleChannels).toContain('push');
      expect(social.eligibleChannels).not.toContain('email');
      expect(social.eligibleChannels).not.toContain('sms');
    });
  });

  describe('priority ordering', () => {
    it('mandatory categories are all priority "critical"', () => {
      for (const { descriptor } of listCategories()) {
        if (descriptor.mandatory) {
          expect(descriptor.priority).toBe('critical');
        }
      }
    });
  });

  describe('isMandatory()', () => {
    it('returns true for Security / Otp / Legal', () => {
      expect(isMandatory(NotificationCategory.Security)).toBe(true);
      expect(isMandatory(NotificationCategory.Otp)).toBe(true);
      expect(isMandatory(NotificationCategory.Legal)).toBe(true);
    });
    it('returns false for everything else', () => {
      expect(isMandatory(NotificationCategory.GiftUpdate)).toBe(false);
      expect(isMandatory(NotificationCategory.Social)).toBe(false);
      expect(isMandatory(NotificationCategory.OccasionReminder)).toBe(false);
      expect(isMandatory(NotificationCategory.System)).toBe(false);
    });
  });

  describe('categoryForType()', () => {
    it('routes gift lifecycle types to GiftUpdate', () => {
      expect(categoryForType(NotificationType.GiftReceived)).toBe(
        NotificationCategory.GiftUpdate,
      );
      expect(categoryForType(NotificationType.GiftPreparing)).toBe(
        NotificationCategory.GiftUpdate,
      );
      expect(categoryForType(NotificationType.GiftShipped)).toBe(
        NotificationCategory.GiftUpdate,
      );
      expect(categoryForType(NotificationType.GiftDelivered)).toBe(
        NotificationCategory.GiftUpdate,
      );
      expect(categoryForType(NotificationType.GiftCancelled)).toBe(
        NotificationCategory.GiftUpdate,
      );
    });

    it('routes address-confirmation types to AddressConfirm', () => {
      expect(categoryForType(NotificationType.GiftConfirmAddress)).toBe(
        NotificationCategory.AddressConfirm,
      );
      expect(categoryForType(NotificationType.GiftAddressConfirmed)).toBe(
        NotificationCategory.AddressConfirm,
      );
      expect(categoryForType(NotificationType.GiftAutoFallbackBlocked)).toBe(
        NotificationCategory.AddressConfirm,
      );
    });

    it('routes GiftPostAppreciated to Social', () => {
      expect(categoryForType(NotificationType.GiftPostAppreciated)).toBe(
        NotificationCategory.Social,
      );
    });

    it('routes unknown types to System (safe default)', () => {
      // System is opt-outable, low-priority, in-app + push only.
      // Far better default than crashing or routing to a
      // mandatory category.
      expect(categoryForType('totally.unknown.event')).toBe(
        NotificationCategory.System,
      );
      expect(categoryForType('')).toBe(NotificationCategory.System);
    });
  });

  describe('listCategories coverage', () => {
    it('every category value in the enum is represented', () => {
      const enumValues = Object.values(NotificationCategory);
      const registered = listCategories().map(({ id }) => id);
      for (const v of enumValues) {
        expect(registered).toContain(v);
      }
    });

    it('returns a fresh array on each call (no shared mutation)', () => {
      const a = listCategories();
      const b = listCategories();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });
});
