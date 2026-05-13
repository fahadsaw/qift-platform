// Hijri ↔ Gregorian conversion helper.
//
// Single shared wrapper around @umalqura/core (the Umm al-Qura
// calendar, official in Saudi Arabia). Every Hijri date conversion
// in the codebase routes through this module — duplicating Hijri
// math anywhere else is a bug waiting to happen.
//
// Why Umm al-Qura specifically (not observational Hijri):
//   - It's the official Saudi government calendar.
//   - It's deterministic — no moon-sighting ambiguity at
//     calculation time (the ±1 day variance for some Eid dates is
//     handled at the UX layer with "around" copy, not by reverting
//     to observational dates).
//   - @umalqura/core is small (no runtime deps), supports both
//     directions, and exposes the leap-year + days-in-month
//     helpers we need for the day-30 fallback.
//
// To swap the underlying library later: change ONLY this file.

import umalqura from '@umalqura/core';

// Re-exported so tests + occasion service code don't need to know
// the library internals.
export type Calendar = 'gregorian' | 'hijri';

// Wrapped types. We treat (year, month, day) as the canonical
// in-calendar representation everywhere; the conversion crosses
// calendars only at the boundary.
export type CalendarDate = {
  calendar: Calendar;
  year: number;
  month: number; // 1-12
  day: number; // 1-31 (per calendar)
};

// ── Days-in-month (calendar-aware) ────────────────────────────
//
// Gregorian: standard 28/29/30/31 with leap-year handling.
// Hijri: 29 or 30 days per month, year-dependent (per Umm al-Qura
// calculation; not the same set every year).
export function daysInMonth(
  calendar: Calendar,
  year: number,
  month: number,
): number {
  if (calendar === 'gregorian') {
    // JS Date: setting day=0 returns the last day of the previous
    // month. Pass `month` (1-12) and we get the last day of THAT
    // month for the given year.
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }
  // Hijri.
  return umalqura.$.getDaysInMonth(year, month);
}

// ── Hijri → Gregorian (with day-overflow fallback) ───────────
//
// Some Hijri months are 29 days; a "day 30" occasion in a 29-day
// month substitutes day 29. Same shape as the Feb-29 → Feb-28
// fallback for Gregorian leap years. Architecture doc Section 4.
//
// Returns a UTC Date at midnight.
export function hijriToGregorianDate(
  year: number,
  month: number,
  day: number,
): Date {
  const max = daysInMonth('hijri', year, month);
  const clamped = Math.min(day, max);
  const out = umalqura.$.hijriToGregorian(year, month, clamped);
  // umalqura returns { gy, gm (1-12), gd }; build a UTC Date so
  // downstream comparisons are timezone-stable.
  return new Date(Date.UTC(out.gy, out.gm - 1, out.gd));
}

// ── Gregorian → Hijri ─────────────────────────────────────────
//
// Used to compute "what Hijri year does this Gregorian date fall
// in" — needed when resolving a yearly recurring Hijri occasion
// (we ask: "in the current Hijri year, when's that date?").
export function gregorianToHijriYear(date: Date): number {
  const wrapped = umalqura(date);
  return wrapped.hy;
}

// ── Build a UTC Gregorian Date from a calendar-aware triple ──
//
// Single entry point for "give me the Gregorian DateTime for
// (calendar, year, month, day)". Routes through the right
// converter; applies the day-overflow fallback for Hijri 30 →
// 29 AND the Gregorian Feb-29 → Feb-28 fallback for non-leap
// years (the JS Date constructor handles month overflow by
// rolling forward, which would silently mis-resolve — we clamp
// the day BEFORE constructing the Date).
//
// Returns the date at UTC midnight. Per-recipient timezone math
// is applied at the reminder-firing layer (Phase 7), NOT here.
export function calendarDateToGregorian(d: CalendarDate): Date {
  if (d.calendar === 'hijri') {
    return hijriToGregorianDate(d.year, d.month, d.day);
  }
  // Gregorian: clamp Feb 29 → Feb 28 in non-leap years.
  const max = daysInMonth('gregorian', d.year, d.month);
  const clamped = Math.min(d.day, max);
  return new Date(Date.UTC(d.year, d.month - 1, clamped));
}
