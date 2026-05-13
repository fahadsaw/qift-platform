// Tests for the shared Hijri ↔ Gregorian wrapper. These run as
// pure unit tests — no Prisma, no Nest harness. The single goal is
// to lock down the calendar-math contract that the rest of the
// occasions infrastructure builds on.

import {
  calendarDateToGregorian,
  daysInMonth,
  gregorianToHijriYear,
  hijriToGregorianDate,
} from './hijri';

describe('hijri helper', () => {
  describe('daysInMonth (gregorian)', () => {
    it('returns 31 for January', () => {
      expect(daysInMonth('gregorian', 2026, 1)).toBe(31);
    });
    it('returns 30 for April', () => {
      expect(daysInMonth('gregorian', 2026, 4)).toBe(30);
    });
    it('returns 28 for February in a non-leap year', () => {
      expect(daysInMonth('gregorian', 2026, 2)).toBe(28);
    });
    it('returns 29 for February in a leap year (2024)', () => {
      expect(daysInMonth('gregorian', 2024, 2)).toBe(29);
    });
    it('returns 28 for February in a non-leap century (2100)', () => {
      // Century rule: 2100 is divisible by 100 but not 400 → NOT a
      // leap year. Locking this down so a future regression to
      // naive y%4 doesn't silently break.
      expect(daysInMonth('gregorian', 2100, 2)).toBe(28);
    });
    it('returns 29 for February in a 400-divisible century (2000)', () => {
      expect(daysInMonth('gregorian', 2000, 2)).toBe(29);
    });
  });

  describe('daysInMonth (hijri)', () => {
    it('returns 29 or 30 for every Hijri month in a sample year', () => {
      for (let m = 1; m <= 12; m += 1) {
        const d = daysInMonth('hijri', 1447, m);
        expect([29, 30]).toContain(d);
      }
    });
    it('returns a value that varies year-over-year for at least one month', () => {
      // Hijri month lengths shift between years (per Umm al-Qura
      // calculation). If every month had the same length every
      // year, the day-30 fallback would never fire and the helper
      // would be over-engineered. This test guards the premise.
      let foundShift = false;
      for (let m = 1; m <= 12; m += 1) {
        if (daysInMonth('hijri', 1447, m) !== daysInMonth('hijri', 1448, m)) {
          foundShift = true;
          break;
        }
      }
      expect(foundShift).toBe(true);
    });
  });

  describe('hijriToGregorianDate', () => {
    it('returns a UTC Date at midnight', () => {
      const d = hijriToGregorianDate(1447, 1, 1);
      expect(d.getUTCHours()).toBe(0);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
      expect(d.getUTCMilliseconds()).toBe(0);
    });
    it('clamps day 30 down to the month max in 29-day months', () => {
      // Find a Hijri month known to have 29 days in our sample year.
      let monthWith29: number | null = null;
      for (let m = 1; m <= 12; m += 1) {
        if (daysInMonth('hijri', 1447, m) === 29) {
          monthWith29 = m;
          break;
        }
      }
      expect(monthWith29).not.toBeNull();
      // Asking for day 30 in a 29-day month should NOT roll forward
      // into the next month (the JS Date constructor would do that
      // for Gregorian — but we clamp first). Compare against the
      // result of asking for day 29 explicitly.
      const requested = hijriToGregorianDate(1447, monthWith29!, 30);
      const clamped = hijriToGregorianDate(1447, monthWith29!, 29);
      expect(requested.getTime()).toBe(clamped.getTime());
    });
    it('does NOT clamp when the month has 30 days', () => {
      // Inverse: in a 30-day Hijri month, day 30 is valid and the
      // result must NOT collapse to day 29.
      let monthWith30: number | null = null;
      for (let m = 1; m <= 12; m += 1) {
        if (daysInMonth('hijri', 1447, m) === 30) {
          monthWith30 = m;
          break;
        }
      }
      expect(monthWith30).not.toBeNull();
      const d30 = hijriToGregorianDate(1447, monthWith30!, 30);
      const d29 = hijriToGregorianDate(1447, monthWith30!, 29);
      expect(d30.getTime()).not.toBe(d29.getTime());
      // And the day-30 date must be exactly one Gregorian day after
      // the day-29 date.
      expect(d30.getTime() - d29.getTime()).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('gregorianToHijriYear', () => {
    it('returns a positive Hijri year for any modern Gregorian date', () => {
      const hy = gregorianToHijriYear(new Date(Date.UTC(2026, 4, 13)));
      // The Hijri year for May 2026 falls in the 1447-1448 range
      // (Hijri lags Gregorian by ~579-580).
      expect(hy).toBeGreaterThan(1400);
      expect(hy).toBeLessThan(1500);
    });
    it('changes across the Hijri new-year boundary', () => {
      // The exact Gregorian date of Hijri new year shifts every
      // year (~11 days earlier each Gregorian year). Rather than
      // hard-code the boundary, scan a year and assert that the
      // Hijri year increments exactly once.
      const start = new Date(Date.UTC(2026, 0, 1));
      const startYear = gregorianToHijriYear(start);
      let endYear = startYear;
      for (let day = 1; day <= 400; day += 1) {
        const d = new Date(start.getTime() + day * 24 * 60 * 60 * 1000);
        endYear = gregorianToHijriYear(d);
        if (endYear !== startYear) break;
      }
      expect(endYear).toBe(startYear + 1);
    });
  });

  describe('calendarDateToGregorian', () => {
    it('routes Gregorian dates through the JS Date constructor (UTC)', () => {
      const d = calendarDateToGregorian({
        calendar: 'gregorian',
        year: 2026,
        month: 5,
        day: 13,
      });
      expect(d.getUTCFullYear()).toBe(2026);
      expect(d.getUTCMonth()).toBe(4); // 0-indexed
      expect(d.getUTCDate()).toBe(13);
      expect(d.getUTCHours()).toBe(0);
    });
    it('clamps Feb 29 to Feb 28 in a non-leap Gregorian year', () => {
      // If we DIDN'T clamp, `new Date(Date.UTC(2026, 1, 29))` would
      // roll forward to March 1. This is the regression guard.
      const d = calendarDateToGregorian({
        calendar: 'gregorian',
        year: 2026,
        month: 2,
        day: 29,
      });
      expect(d.getUTCMonth()).toBe(1); // February
      expect(d.getUTCDate()).toBe(28);
    });
    it('keeps Feb 29 in a leap year', () => {
      const d = calendarDateToGregorian({
        calendar: 'gregorian',
        year: 2024,
        month: 2,
        day: 29,
      });
      expect(d.getUTCMonth()).toBe(1);
      expect(d.getUTCDate()).toBe(29);
    });
    it('clamps Hijri day 30 to month max in 29-day months', () => {
      // Locate a 29-day Hijri month and verify the fallback runs
      // through calendarDateToGregorian (not just the bare
      // hijriToGregorianDate path).
      let monthWith29: number | null = null;
      for (let m = 1; m <= 12; m += 1) {
        if (daysInMonth('hijri', 1447, m) === 29) {
          monthWith29 = m;
          break;
        }
      }
      expect(monthWith29).not.toBeNull();
      const requested = calendarDateToGregorian({
        calendar: 'hijri',
        year: 1447,
        month: monthWith29!,
        day: 30,
      });
      const clamped = calendarDateToGregorian({
        calendar: 'hijri',
        year: 1447,
        month: monthWith29!,
        day: 29,
      });
      expect(requested.getTime()).toBe(clamped.getTime());
    });
    it('roundtrips a Hijri date back to the same Hijri year', () => {
      const greg = calendarDateToGregorian({
        calendar: 'hijri',
        year: 1447,
        month: 6,
        day: 15,
      });
      expect(gregorianToHijriYear(greg)).toBe(1447);
    });
  });
});
