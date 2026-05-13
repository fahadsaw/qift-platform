// Allow-listed occasion kinds. Adding a new kind is a deliberate
// four-place change:
//   1. Add the slug here.
//   2. Add a default reminder cadence below (if it differs from
//      the kind's category default).
//   3. Add a translation key on the frontend.
//   4. Update project_occasions_architecture.md Section 3.3.
//
// Free-text kinds are NOT supported — the `custom` slug + label
// covers the user-defined case without opening the validation
// surface.

export const OCCASION_KINDS = [
  // Personal recurring
  'birthday',
  'anniversary_relationship',
  'anniversary_work',
  'anniversary_other',

  // Religious / cultural
  'eid_al_fitr',
  'eid_al_adha',
  'ramadan',
  'hijri_new_year',
  'mawlid',
  'ashura',
  'mothers_day',
  'fathers_day',
  'saudi_national_day',
  'new_year',

  // Life milestones
  'graduation',
  'engagement',
  'wedding',
  'new_baby',
  'new_home',
  'new_job',
  'promotion',
  'retirement',

  // Achievement
  'degree',
  'exam_success',
  'milestone',

  // Acknowledgement (typically one-off, often tagged retroactively)
  'thank_you',
  'congratulations',
  'sympathy',
  'get_well',
  'just_because',

  // User-defined
  'custom',
] as const;

export type OccasionKind = (typeof OCCASION_KINDS)[number];

export function isOccasionKind(value: string): value is OccasionKind {
  return (OCCASION_KINDS as readonly string[]).includes(value);
}

// Default reminder cadence per kind. Returns an array of
// `daysBefore` values; the OccasionsService seeds these as
// OccasionReminder rows when an occasion is created (the user
// can override or disable per row afterwards).
//
// Architecture doc Section 7.2.
//
// All defaults are `channel = digest` — the architecture's
// notification discipline keeps low-priority reminders in the
// daily digest; explicit opt-in promotes to real_time. Phase 7's
// notification budget infrastructure controls firing.
export function defaultCadenceFor(kind: OccasionKind): number[] {
  // Life milestones — short window, high stakes. Real-time
  // promotion is the right default but FIRING is gated to
  // Phase 7 regardless. Cadence: T-14, T-3, T-0.
  if (
    kind === 'engagement' ||
    kind === 'wedding' ||
    kind === 'new_baby' ||
    kind === 'new_home' ||
    kind === 'new_job' ||
    kind === 'promotion' ||
    kind === 'graduation' ||
    kind === 'retirement'
  ) {
    return [14, 3, 0];
  }
  // Achievements — one-off; remind on the day so the sender
  // can send a thank-you / congrats.
  if (kind === 'degree' || kind === 'exam_success' || kind === 'milestone') {
    return [0];
  }
  // Acknowledgement kinds — no future date by definition; used
  // for retroactively tagging gifts. No reminder cadence.
  if (
    kind === 'thank_you' ||
    kind === 'congratulations' ||
    kind === 'sympathy' ||
    kind === 'get_well' ||
    kind === 'just_because'
  ) {
    return [];
  }
  // Religious / cultural — single T-7 reminder. The user can
  // override per-occasion.
  if (
    kind === 'eid_al_fitr' ||
    kind === 'eid_al_adha' ||
    kind === 'ramadan' ||
    kind === 'hijri_new_year' ||
    kind === 'mawlid' ||
    kind === 'ashura' ||
    kind === 'mothers_day' ||
    kind === 'fathers_day' ||
    kind === 'saudi_national_day' ||
    kind === 'new_year'
  ) {
    return [7];
  }
  // Personal recurring (birthday, anniversaries) + custom.
  // T-7 and T-1 — calmest cadence that still gives the user
  // time to plan a gift.
  return [7, 1];
}
