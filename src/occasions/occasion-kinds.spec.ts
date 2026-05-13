// Tests for the kind allow-list + default-cadence map. These are
// nearly-trivial functions but the cadence policy is product-
// critical (it defines the day-one reminder noise floor for every
// new occasion), so we lock the table down explicitly.

import {
  OCCASION_KINDS,
  defaultCadenceFor,
  isOccasionKind,
} from './occasion-kinds';

describe('isOccasionKind', () => {
  it('returns true for every allow-listed kind', () => {
    for (const k of OCCASION_KINDS) {
      expect(isOccasionKind(k)).toBe(true);
    }
  });
  it('returns false for unrelated strings', () => {
    expect(isOccasionKind('not_a_kind')).toBe(false);
    expect(isOccasionKind('')).toBe(false);
    expect(isOccasionKind('BIRTHDAY')).toBe(false); // case-sensitive
  });
  it('does NOT accept the literal "Custom" — only lowercase "custom"', () => {
    expect(isOccasionKind('Custom')).toBe(false);
    expect(isOccasionKind('custom')).toBe(true);
  });
});

describe('defaultCadenceFor', () => {
  describe('life milestones — [14, 3, 0]', () => {
    const milestones = [
      'engagement',
      'wedding',
      'new_baby',
      'new_home',
      'new_job',
      'promotion',
      'graduation',
      'retirement',
    ] as const;
    for (const k of milestones) {
      it(`returns [14, 3, 0] for ${k}`, () => {
        expect(defaultCadenceFor(k)).toEqual([14, 3, 0]);
      });
    }
  });

  describe('achievement — [0]', () => {
    const achievements = ['degree', 'exam_success', 'milestone'] as const;
    for (const k of achievements) {
      it(`returns [0] for ${k}`, () => {
        expect(defaultCadenceFor(k)).toEqual([0]);
      });
    }
  });

  describe('acknowledgement — [] (no cadence)', () => {
    const ack = [
      'thank_you',
      'congratulations',
      'sympathy',
      'get_well',
      'just_because',
    ] as const;
    for (const k of ack) {
      it(`returns [] for ${k}`, () => {
        expect(defaultCadenceFor(k)).toEqual([]);
      });
    }
  });

  describe('religious / cultural — [7]', () => {
    const religious = [
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
    ] as const;
    for (const k of religious) {
      it(`returns [7] for ${k}`, () => {
        expect(defaultCadenceFor(k)).toEqual([7]);
      });
    }
  });

  describe('personal recurring + custom — [7, 1]', () => {
    const personal = [
      'birthday',
      'anniversary_relationship',
      'anniversary_work',
      'anniversary_other',
      'custom',
    ] as const;
    for (const k of personal) {
      it(`returns [7, 1] for ${k}`, () => {
        expect(defaultCadenceFor(k)).toEqual([7, 1]);
      });
    }
  });

  describe('coverage invariant', () => {
    it('returns a defined array for every allow-listed kind', () => {
      // No allow-listed kind may fall through to an undefined
      // cadence. If a new kind is added without a cadence assignment
      // it'll be silently absorbed by the personal-recurring fallback
      // — that's intended behavior, but the array must still exist.
      for (const k of OCCASION_KINDS) {
        const cadence = defaultCadenceFor(k);
        expect(Array.isArray(cadence)).toBe(true);
      }
    });
    it('returns only non-negative integers ≤ 60', () => {
      // The reminder upsert rejects daysBefore outside 0..60, so
      // every default must fit inside that range or seeding fails.
      for (const k of OCCASION_KINDS) {
        for (const d of defaultCadenceFor(k)) {
          expect(Number.isInteger(d)).toBe(true);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(60);
        }
      }
    });
  });
});
