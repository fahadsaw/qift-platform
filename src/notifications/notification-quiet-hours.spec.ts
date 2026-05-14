// Tests for the quiet-hours helper. Covers the three real-world
// windows + the TZ + malformed-input edges:
//   1. Same-day window (e.g. 13:00 → 14:00 siesta)
//   2. Cross-midnight window (e.g. 22:00 → 08:00 overnight)
//   3. Same start/end (full 24-hour mute)
// Plus malformed HH:MM, unrecognised TZ, missing fields, and
// the cross-TZ projection (a Riyadh user vs a London user
// seeing the same UTC instant differently).

import { inQuietHours } from './notification-quiet-hours';

// Helper: build a UTC Date at a specific hour/minute. Tests
// supply UTC because that's what `new Date()` returns at the
// service boundary.
const utc = (year: number, month: number, day: number, h: number, m: number) =>
  new Date(Date.UTC(year, month - 1, day, h, m));

describe('inQuietHours', () => {
  describe('disabled / unconfigured', () => {
    it('returns false when both ends are null', () => {
      expect(
        inQuietHours(
          { start: null, end: null, timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 12, 0),
        ),
      ).toBe(false);
    });

    it('returns false when start is null (half-configured)', () => {
      // Half-configured state is rejected at the SERVICE layer
      // (NotificationPreferencesService throws). Defence-in-depth:
      // if a corrupted row arrives here, treat as "no quiet hours".
      expect(
        inQuietHours(
          { start: null, end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 23, 0),
        ),
      ).toBe(false);
    });

    it('returns false when end is null (half-configured)', () => {
      expect(
        inQuietHours(
          { start: '22:00', end: null, timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 23, 0),
        ),
      ).toBe(false);
    });
  });

  describe('malformed inputs (fail-open)', () => {
    it('returns false for unparseable HH:MM start', () => {
      expect(
        inQuietHours(
          { start: 'late', end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 12, 0),
        ),
      ).toBe(false);
    });

    it('returns false for out-of-range hour', () => {
      // 25:00 is not a valid hour. Refuse to block delivery.
      expect(
        inQuietHours(
          { start: '25:00', end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 12, 0),
        ),
      ).toBe(false);
    });

    it('returns false for an unrecognised timezone', () => {
      // Intl throws RangeError on the unknown TZ; helper catches.
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Mars/Olympus_Mons' },
          utc(2026, 5, 15, 23, 0),
        ),
      ).toBe(false);
    });
  });

  describe('same-day window (start < end)', () => {
    // 13:00 → 14:00 LOCAL (Asia/Riyadh = UTC+3, no DST).
    // 13:00 Riyadh = 10:00 UTC; 14:00 Riyadh = 11:00 UTC.

    it('inside window — 13:30 local = 10:30 UTC', () => {
      expect(
        inQuietHours(
          { start: '13:00', end: '14:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 10, 30),
        ),
      ).toBe(true);
    });

    it('exactly at start — 13:00 local = 10:00 UTC', () => {
      expect(
        inQuietHours(
          { start: '13:00', end: '14:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 10, 0),
        ),
      ).toBe(true);
    });

    it('exactly at end — 14:00 local = 11:00 UTC (exclusive)', () => {
      // Half-open interval: [start, end). End is exclusive so a
      // user with 22:00→08:00 quiet hours can be reached at 08:00.
      expect(
        inQuietHours(
          { start: '13:00', end: '14:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 11, 0),
        ),
      ).toBe(false);
    });

    it('before window — 12:00 local = 09:00 UTC', () => {
      expect(
        inQuietHours(
          { start: '13:00', end: '14:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 9, 0),
        ),
      ).toBe(false);
    });

    it('after window — 15:00 local = 12:00 UTC', () => {
      expect(
        inQuietHours(
          { start: '13:00', end: '14:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 12, 0),
        ),
      ).toBe(false);
    });
  });

  describe('cross-midnight window (start > end)', () => {
    // 22:00 → 08:00 LOCAL (Asia/Riyadh).
    // 22:00 Riyadh = 19:00 UTC; 08:00 Riyadh = 05:00 UTC.

    it('inside late-evening — 23:00 local = 20:00 UTC', () => {
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 20, 0),
        ),
      ).toBe(true);
    });

    it('inside very early morning — 03:00 local = 00:00 UTC', () => {
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 0, 0),
        ),
      ).toBe(true);
    });

    it('exactly at start — 22:00 local = 19:00 UTC', () => {
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 19, 0),
        ),
      ).toBe(true);
    });

    it('exactly at end — 08:00 local = 05:00 UTC (exclusive)', () => {
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 5, 0),
        ),
      ).toBe(false);
    });

    it('mid-day — 14:00 local = 11:00 UTC (outside the window)', () => {
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 11, 0),
        ),
      ).toBe(false);
    });
  });

  describe('full 24-hour mute (start === end)', () => {
    it('always returns true regardless of `now`', () => {
      // The helper short-circuits without projecting `now` into
      // the timezone — saves an Intl format call for the extreme
      // user choice.
      expect(
        inQuietHours(
          { start: '00:00', end: '00:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 12, 0),
        ),
      ).toBe(true);
      expect(
        inQuietHours(
          { start: '22:00', end: '22:00', timezone: 'Asia/Riyadh' },
          utc(2026, 5, 15, 3, 0),
        ),
      ).toBe(true);
    });
  });

  describe('cross-timezone behaviour', () => {
    it('UTC 19:00 is night in Riyadh (22:00) but evening in London (20:00)', () => {
      // Riyadh user with 22:00→08:00 quiet hours sees 22:00 → YES quiet.
      // London user with the same setting sees 20:00 → NO quiet.
      // Same UTC instant, different decisions — proving the TZ
      // projection is doing its job.
      const utcInstant = utc(2026, 5, 15, 19, 0);
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Asia/Riyadh' },
          utcInstant,
        ),
      ).toBe(true);
      expect(
        inQuietHours(
          { start: '22:00', end: '08:00', timezone: 'Europe/London' },
          utcInstant,
        ),
      ).toBe(false);
    });
  });
});
