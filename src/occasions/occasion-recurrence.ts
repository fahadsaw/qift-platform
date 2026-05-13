// Occasion recurrence resolver. Pure functions — no Prisma, no
// service dependencies — so the math is independently testable.
//
// The single public entry point is `nextOccurrence(spec, after)`,
// which returns the next Gregorian UTC Date at midnight on or
// after `after`, OR null if the occasion is one-off and has
// already passed.
//
// The architecture decision baked in here: occasions store
// (calendar, year?, month, day) — NOT a DateTime — so recurrence
// math stays calendar-aware. A naive Gregorian DateTime can't
// resolve "every year on the second of Shawwal" because Hijri
// drifts ~11 days per Gregorian year.
//
// See project_occasions_architecture.md Section 4 for the full
// rationale. Tests in occasion-recurrence.spec.ts cover the
// leap-year edge case (Feb 29), the Hijri day-30 fallback, and
// the once-vs-yearly contract.

import {
  calendarDateToGregorian,
  gregorianToHijriYear,
  type Calendar,
} from '../lib/hijri';

export type OccasionDateSpec = {
  calendar: Calendar;
  // For 'once' occasions: the year IS the occurrence year (e.g.
  // graduation on 15 June 2026 → year=2026). For 'yearly'
  // recurring: year is null (the resolver picks the right year
  // based on `after`).
  year: number | null;
  month: number;
  day: number;
  recurrence: 'once' | 'yearly';
};

// Compute the next occurrence of `spec` on or after `after`.
// Returns a UTC Date at midnight OR null when:
//   - the occasion is 'once' AND `after` is already past it
//   - the spec is malformed (shouldn't happen at runtime; the
//     service layer validates before this is called)
//
// Per-recipient timezone math is applied at the reminder-firing
// layer (Phase 7), NOT here. Returning UTC midnight is the
// canonical anchor.
export function nextOccurrence(
  spec: OccasionDateSpec,
  after: Date,
): Date | null {
  if (spec.recurrence === 'once') {
    if (spec.year === null) {
      // 'once' without a year is invalid — but defend against it
      // here so a corrupted row never silently misbehaves.
      return null;
    }
    const d = calendarDateToGregorian({
      calendar: spec.calendar,
      year: spec.year,
      month: spec.month,
      day: spec.day,
    });
    // Compare at day granularity. An occasion firing TODAY is in
    // the future for the purpose of "next" — the reminder sweep
    // wants to surface it before the day passes.
    return d.getTime() >= startOfUtcDay(after).getTime() ? d : null;
  }

  // recurrence === 'yearly'.
  //
  // Strategy: start at the current year IN THE OCCASION'S
  // CALENDAR, build the date, and if it's already passed, roll
  // forward year-by-year. We cap at 2 years to defend against
  // a pathological input where (month, day) never resolves
  // (shouldn't happen with the day-overflow fallback in
  // calendarDateToGregorian — but defence in depth).
  const startingYear = currentYearInCalendar(spec.calendar, after);
  for (let yr = startingYear; yr <= startingYear + 2; yr += 1) {
    const d = calendarDateToGregorian({
      calendar: spec.calendar,
      year: yr,
      month: spec.month,
      day: spec.day,
    });
    if (d.getTime() >= startOfUtcDay(after).getTime()) {
      return d;
    }
  }
  return null;
}

// Helper: the current year value to use when iterating yearly
// recurrence. For Gregorian, that's just date.getUTCFullYear().
// For Hijri, we convert through the umalqura helper so the year
// reflects the Hijri calendar's current value (which can lag the
// Gregorian year by ~579 / ~580).
function currentYearInCalendar(calendar: Calendar, date: Date): number {
  if (calendar === 'gregorian') return date.getUTCFullYear();
  return gregorianToHijriYear(date);
}

// Round to UTC midnight. The reminder sweep compares calendar
// dates, not instants — an occasion firing "today" at 00:00 UTC
// is the SAME as an instant at 12:00 UTC for the purposes of
// "is this happening this day?". Stripping the time component
// here removes ambiguity.
function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
