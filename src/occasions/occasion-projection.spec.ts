// Tests for the Phase 6.2 projection helpers. These are pure
// functions — no Prisma, no Nest harness — but they encode three
// load-bearing privacy + correctness contracts:
//
//   1. canSeeOccasion is the single gate. projectOccasionForViewer
//      MUST return null when the gate denies, even if every other
//      field looks valid.
//   2. Year-strip on `yearly` rows. The original year is typically
//      a birth-year; the relationship-safe projection MUST NOT
//      leak it.
//   3. daysUntil + bucket are derived from UTC-midnight day deltas,
//      not raw ms deltas — so "tomorrow at 23:00 UTC" stays "tomorrow".

import {
  bucketFor,
  daysUntilUtc,
  projectOccasionForViewer,
  projectOwnOccasion,
  sortUpcoming,
  type OccasionRow,
  type OwnerSummary,
  type RelationshipOccasion,
} from './occasion-projection';
import type { ViewerContext } from './occasion-privacy';

const OWNER_ID = 'owner-1';
const VIEWER_ID = 'viewer-1';

const row = (overrides: Partial<OccasionRow> = {}): OccasionRow => ({
  id: 'occ-1',
  userId: OWNER_ID,
  kind: 'birthday',
  label: null,
  calendar: 'gregorian',
  year: 1995,
  month: 6,
  day: 15,
  recurrence: 'yearly',
  visibility: 'followers',
  regionCode: null,
  relatedUserId: null,
  ...overrides,
});

const ctx = (overrides: Partial<ViewerContext> = {}): ViewerContext => ({
  viewerId: VIEWER_ID,
  viewerFollowsOwner: false,
  ownerFollowsViewer: false,
  blocked: false,
  ...overrides,
});

const owner: OwnerSummary = {
  id: OWNER_ID,
  qiftUsername: 'owner_one',
  fullName: 'Owner One',
  avatarUrl: null,
};

describe('daysUntilUtc', () => {
  it('returns 0 when next is the same UTC day as now', () => {
    const now = new Date(Date.UTC(2026, 4, 13, 8, 0, 0));
    const next = new Date(Date.UTC(2026, 4, 13, 23, 30, 0));
    expect(daysUntilUtc(next, now)).toBe(0);
  });
  it('returns 1 for the next UTC day even across a tiny ms delta', () => {
    const now = new Date(Date.UTC(2026, 4, 13, 23, 59, 59));
    const next = new Date(Date.UTC(2026, 4, 14, 0, 0, 0));
    expect(daysUntilUtc(next, now)).toBe(1);
  });
  it('returns 30 for a date one month out', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const next = new Date(Date.UTC(2026, 0, 31));
    expect(daysUntilUtc(next, now)).toBe(30);
  });
  it('returns null when next is in the past', () => {
    const now = new Date(Date.UTC(2026, 4, 13));
    const next = new Date(Date.UTC(2026, 4, 12));
    expect(daysUntilUtc(next, now)).toBeNull();
  });
});

describe('bucketFor', () => {
  it('maps day deltas to the correct bucket', () => {
    expect(bucketFor(0)).toBe('today');
    expect(bucketFor(1)).toBe('tomorrow');
    expect(bucketFor(2)).toBe('this_week');
    expect(bucketFor(7)).toBe('this_week');
    expect(bucketFor(8)).toBe('this_month');
    expect(bucketFor(30)).toBe('this_month');
    expect(bucketFor(31)).toBe('later');
    expect(bucketFor(365)).toBe('later');
  });
  it('treats negatives as today (defensive — daysUntilUtc clamps these out)', () => {
    expect(bucketFor(-1)).toBe('today');
  });
});

describe('projectOwnOccasion', () => {
  it('returns a PublicOccasion with year preserved + resolved nextOccurrenceAt', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOwnOccasion(row({ year: 1995 }), now);
    expect(out.year).toBe(1995);
    expect(out.kind).toBe('birthday');
    expect(out.visibility).toBe('followers');
    expect(out.nextOccurrenceAt).toMatch(/^2026-06-15T00:00:00\.000Z$/);
  });
  it('returns nextOccurrenceAt: null for past one-off occasions', () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    const out = projectOwnOccasion(
      row({ recurrence: 'once', year: 2024 }),
      now,
    );
    expect(out.nextOccurrenceAt).toBeNull();
  });
});

describe('projectOccasionForViewer — gate enforcement', () => {
  it('returns null when canSeeOccasion denies (followers, viewer does not follow)', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: false }),
      row({ visibility: 'followers' }),
      now,
    );
    expect(out).toBeNull();
  });
  it('returns null when the viewer is blocked', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ blocked: true, viewerFollowsOwner: true }),
      row({ visibility: 'public' }),
      now,
    );
    expect(out).toBeNull();
  });
  it('returns null for private rows even if owner = null is corrupted', () => {
    // Defence-in-depth: a corrupted row that drops to userId=null
    // would otherwise leak through the cultural-row branch. The
    // gate routes cultural rows through the public-only check —
    // a private cultural row stays denied.
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx(),
      row({ userId: null, visibility: 'private' }),
      now,
    );
    expect(out).toBeNull();
  });
  it('returns a projection when canSeeOccasion grants (followers + viewer follows)', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ visibility: 'followers' }),
      now,
    );
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('birthday');
  });
});

describe('projectOccasionForViewer — privacy trim', () => {
  it('strips the year on yearly rows (birth-year leak protection)', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ recurrence: 'yearly', year: 1995, visibility: 'followers' }),
      now,
    );
    expect(out).not.toBeNull();
    expect(out!.year).toBeNull();
  });
  it('keeps the year on once rows (the year IS the occurrence)', () => {
    // For 'once' the year IS the event year (graduation 2026,
    // wedding 2027). Stripping it would lose information that
    // visibility already consented to.
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ recurrence: 'once', year: 2026, visibility: 'followers' }),
      now,
    );
    expect(out).not.toBeNull();
    expect(out!.year).toBe(2026);
  });
  it('does NOT include the visibility tier in the projected shape', () => {
    // visibility is an owner-side setting. Leaking it to viewers
    // signals "X is restricting this to followers" — itself a
    // small information leak. Strip at the projection boundary.
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ visibility: 'followers' }),
      now,
    );
    expect(out).not.toBeNull();
    expect(
      (out as unknown as Record<string, unknown>).visibility,
    ).toBeUndefined();
  });
});

describe('projectOccasionForViewer — timing + owner', () => {
  it('attaches owner summary when provided', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ visibility: 'followers' }),
      now,
      owner,
    );
    expect(out).not.toBeNull();
    expect(out!.owner).toEqual(owner);
  });
  it('owner defaults to null when not provided', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ visibility: 'followers' }),
      now,
    );
    expect(out!.owner).toBeNull();
  });
  it('resolves daysUntil + bucket against `now` (this_month for June 15 starting Jan 1)', () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ visibility: 'followers' }),
      now,
    );
    expect(out!.daysUntil).toBeGreaterThan(30);
    expect(out!.bucket).toBe('later');
  });
  it('reports today + 0 daysUntil on the occasion day', () => {
    const now = new Date(Date.UTC(2026, 5, 15, 10, 0, 0));
    const out = projectOccasionForViewer(
      ctx({ viewerFollowsOwner: true }),
      row({ visibility: 'followers' }),
      now,
    );
    expect(out!.daysUntil).toBe(0);
    expect(out!.bucket).toBe('today');
  });
});

describe('sortUpcoming', () => {
  const mk = (daysUntil: number | null, id: string): RelationshipOccasion => ({
    id,
    kind: 'birthday',
    label: null,
    calendar: 'gregorian',
    year: null,
    month: 1,
    day: 1,
    recurrence: 'yearly',
    regionCode: null,
    nextOccurrenceAt: daysUntil === null ? null : '2026-01-01T00:00:00.000Z',
    daysUntil,
    bucket: daysUntil === null ? null : 'today',
    owner: null,
  });

  it('drops nulls (denied rows) AND rows with null daysUntil (past one-offs)', () => {
    const out = sortUpcoming([null, mk(5, 'a'), mk(null, 'b'), mk(1, 'c')]);
    expect(out.map((r) => r.id)).toEqual(['c', 'a']);
  });
  it('orders by daysUntil ascending — soonest first', () => {
    const out = sortUpcoming([
      mk(30, 'd'),
      mk(0, 'a'),
      mk(7, 'b'),
      mk(15, 'c'),
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('preserves stable order for equal daysUntil (sort stability)', () => {
    const out = sortUpcoming([mk(5, 'a'), mk(5, 'b'), mk(5, 'c')]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
