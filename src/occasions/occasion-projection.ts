// Phase 6.2 — Occasion projection.
//
// Single-source-of-truth for "how does an occasion row appear over
// the wire". Two projection shapes:
//
//   PublicOccasion         — owner's own view. Full date triple,
//                            year included, visibility shown.
//   RelationshipOccasion   — what a follower / mutual / public
//                            visitor sees. Year stripped for
//                            `yearly` rows (birth-year inference
//                            is a privacy leak). Adds the
//                            resolved `daysUntil` + `bucket`
//                            label so the UI doesn't recompute,
//                            plus an optional `owner` summary
//                            for feed-style surfaces.
//
// Privacy ENFORCEMENT lives in canSeeOccasion (occasion-privacy.ts).
// This file is projection-only — it runs AFTER the gate. Callers
// MUST filter through canSeeOccasion first; passing a denied row
// here is a bug.

import { nextOccurrence } from './occasion-recurrence';
import type {
  OccasionPrivacySubject,
  OccasionVisibility,
  ViewerContext,
} from './occasion-privacy';
import { canSeeOccasion } from './occasion-privacy';
import type { Calendar } from '../lib/hijri';

// ── Raw shape (matches the Prisma row, narrowed to projection-
// relevant fields). Decoupled from Prisma's generated types so this
// module stays pure and unit-testable.
export type OccasionRow = {
  id: string;
  userId: string | null;
  kind: string;
  label: string | null;
  calendar: string;
  year: number | null;
  month: number;
  day: number;
  recurrence: string;
  visibility: string;
  regionCode: string | null;
  relatedUserId: string | null;
};

// Owner-side projection. Used by `listMine`, `findOneOwned`, the
// returned shape of create/update. Year is preserved (the owner
// always sees their own data fully).
export type PublicOccasion = {
  id: string;
  kind: string;
  label: string | null;
  calendar: Calendar;
  year: number | null;
  month: number;
  day: number;
  recurrence: 'once' | 'yearly';
  visibility: OccasionVisibility;
  regionCode: string | null;
  relatedUserId: string | null;
  // Resolved at read time; ISO string. The UI formats per locale.
  nextOccurrenceAt: string | null;
};

// Relationship-safe owner summary. The minimum a visitor needs to
// recognize whose occasion this is. Driven by the User table; the
// caller hydrates this map once per list query.
export type OwnerSummary = {
  id: string;
  qiftUsername: string;
  fullName: string | null;
  avatarUrl: string | null;
};

// Relationship-side projection. Differences vs PublicOccasion:
//   - Year is stripped on `yearly` rows (birth-year privacy).
//   - Visibility is omitted (it's an owner-side setting; visitors
//     don't need to see it).
//   - Adds `daysUntil` + `bucket` so feed rendering is allocation-
//     free in the UI.
//   - Optional `owner` summary — null for surfaces where the owner
//     is already implied by the route (e.g. /users/:id/occasions).
export type RelationshipOccasion = {
  id: string;
  kind: string;
  label: string | null;
  calendar: Calendar;
  // Year present ONLY for one-off occasions (e.g. graduation 2026
  // — the year IS the occurrence). Stripped for yearly to avoid
  // leaking age / birth-year.
  year: number | null;
  month: number;
  day: number;
  recurrence: 'once' | 'yearly';
  regionCode: string | null;
  nextOccurrenceAt: string | null;
  daysUntil: number | null;
  bucket: RelativeBucket | null;
  owner: OwnerSummary | null;
};

// Coarse-grained timing bucket. The UI maps each to a locale-aware
// label ("today", "in 3 days", "next week", "this month", "later").
// Keeping the API a fixed enum keeps i18n on the client and avoids
// a server-side language detection step.
export type RelativeBucket =
  | 'today'
  | 'tomorrow'
  | 'this_week' // 2..7 days
  | 'this_month' // 8..30 days
  | 'later'; // > 30 days

// ── Pure projection helpers ─────────────────────────────────────

// Days between `now` and `next` at UTC-day granularity. Negative
// values (the occurrence has passed) are clamped to null — past
// occasions never surface in the upcoming projection, and this
// helper is the last line of defence against a stale row.
export function daysUntilUtc(next: Date, now: Date): number | null {
  const day = 24 * 60 * 60 * 1000;
  const nowMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const nextMidnight = Date.UTC(
    next.getUTCFullYear(),
    next.getUTCMonth(),
    next.getUTCDate(),
  );
  const diff = Math.round((nextMidnight - nowMidnight) / day);
  return diff < 0 ? null : diff;
}

// Map a day count to its coarse bucket. The buckets are
// deliberately wide — Qift is relationship-first, not
// time-pressure-first. We don't surface "3 hours left!" copy.
export function bucketFor(daysUntil: number): RelativeBucket {
  if (daysUntil <= 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  if (daysUntil <= 7) return 'this_week';
  if (daysUntil <= 30) return 'this_month';
  return 'later';
}

// Owner-side projection. Always succeeds — the owner sees every
// field of their own row. The caller is responsible for filtering
// to live (deactivatedAt IS NULL) rows; this helper doesn't know
// about soft-deletes.
export function projectOwnOccasion(
  row: OccasionRow,
  now: Date,
): PublicOccasion {
  const next = nextOccurrence(
    {
      calendar: row.calendar as Calendar,
      year: row.year,
      month: row.month,
      day: row.day,
      recurrence: row.recurrence as 'once' | 'yearly',
    },
    now,
  );
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    calendar: row.calendar as Calendar,
    year: row.year,
    month: row.month,
    day: row.day,
    recurrence: row.recurrence as 'once' | 'yearly',
    visibility: row.visibility as OccasionVisibility,
    regionCode: row.regionCode,
    relatedUserId: row.relatedUserId,
    nextOccurrenceAt: next ? next.toISOString() : null,
  };
}

// Relationship-side projection. Returns null when the viewer is
// NOT allowed to see the row (centralized through canSeeOccasion).
// Callers MUST tolerate null and skip those rows — relying on the
// caller-side filter alone is the bug pattern this guards against.
export function projectOccasionForViewer(
  viewer: ViewerContext,
  row: OccasionRow,
  now: Date,
  owner?: OwnerSummary | null,
): RelationshipOccasion | null {
  const subject: OccasionPrivacySubject = {
    userId: row.userId,
    visibility: row.visibility as OccasionVisibility,
  };
  if (!canSeeOccasion(viewer, subject)) return null;

  const next = nextOccurrence(
    {
      calendar: row.calendar as Calendar,
      year: row.year,
      month: row.month,
      day: row.day,
      recurrence: row.recurrence as 'once' | 'yearly',
    },
    now,
  );
  const daysUntil = next ? daysUntilUtc(next, now) : null;
  const bucket = daysUntil === null ? null : bucketFor(daysUntil);

  // Privacy trim: strip the year on YEARLY rows. The original year
  // is typically the birth-year and inferring age from it is a
  // leak the visibility tier does NOT consent to. One-off rows
  // (graduation 2026) keep the year because the year IS the
  // occurrence date.
  const recurrence = row.recurrence as 'once' | 'yearly';
  const safeYear = recurrence === 'once' ? row.year : null;

  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    calendar: row.calendar as Calendar,
    year: safeYear,
    month: row.month,
    day: row.day,
    recurrence,
    regionCode: row.regionCode,
    nextOccurrenceAt: next ? next.toISOString() : null,
    daysUntil,
    bucket,
    owner: owner ?? null,
  };
}

// Filter + sort a list of relationship projections by upcoming
// timing. Drops nulls (denied or past) and orders by daysUntil
// ascending so the soonest occasion is first. Used by the
// upcoming-for-followed feed.
export function sortUpcoming(
  projections: Array<RelationshipOccasion | null>,
): RelationshipOccasion[] {
  return projections
    .filter((p): p is RelationshipOccasion => p !== null)
    .filter((p) => p.daysUntil !== null)
    .sort((a, b) => (a.daysUntil ?? 0) - (b.daysUntil ?? 0));
}
