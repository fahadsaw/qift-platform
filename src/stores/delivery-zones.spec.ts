// Coverage matcher tests — PR 4 (Coverage 2b): wildcard support +
// Arabic normalization parity with the frontend.
//
// CONTRACT THIS SPEC PINS
//   1. Legacy { city } / { city, districts } rows behave EXACTLY as
//      before (city gate, optional district whitelist, legacy
//      single-city fallback when no zones exist).
//   2. Wildcard rows admit broader scopes: { country } matches any
//      address in that country; { country, region } any address in
//      that region. Unset zone fields are wildcards.
//   3. Conservative gates: a scoped wildcard does NOT match an
//      address that lacks the scoped field (no green-lighting
//      unknown destinations).
//   4. parseStoreZones keeps any row with at least one scope and
//      drops empty/corrupt rows (previously rows without `city`
//      were dropped — the wildcard-destroying bug).
//   5. normaliseCity folds the same variants as the frontend's
//      normalizeArabic: hamza alefs, teh marbuta, alef maksura,
//      tashkeel/tatweel, definite article, Latin al-/el- prefixes.
//
// Keep fixtures in lock-step with qift-ui-v2 lib/deliveryZones.ts.

import {
  matchAddressToStoreZones,
  normaliseCity,
  parseStoreZones,
  type DeliveryZone,
} from './delivery-zones';

const STORE_CITY = 'الرياض';

function match(
  address: {
    country?: string | null;
    region?: string | null;
    city?: string | null;
    district?: string | null;
  },
  zones: DeliveryZone[] | null,
  isFastDelivery = true,
) {
  return matchAddressToStoreZones(
    {
      country: address.country ?? null,
      region: address.region ?? null,
      city: address.city ?? null,
      district: address.district ?? null,
    },
    { city: STORE_CITY, deliveryZones: zones },
    isFastDelivery,
  );
}

describe('normaliseCity — parity with frontend normalizeArabic', () => {
  it('folds teh marbuta to heh (جدة ↔ جده)', () => {
    expect(normaliseCity('جدة')).toBe(normaliseCity('جده'));
  });

  it('folds hamza alef variants (أبها ↔ ابها)', () => {
    expect(normaliseCity('أبها')).toBe(normaliseCity('ابها'));
  });

  it('folds alef maksura to yeh', () => {
    expect(normaliseCity('مصلى')).toBe(normaliseCity('مصلي'));
  });

  it('strips the definite article', () => {
    expect(normaliseCity('الرياض')).toBe(normaliseCity('رياض'));
  });

  it('strips Latin transliteration prefixes', () => {
    expect(normaliseCity('Al-Riyadh')).toBe(normaliseCity('riyadh'));
  });

  it('strips tashkeel and tatweel', () => {
    expect(normaliseCity('الرِّيَاض')).toBe(normaliseCity('الرياض'));
  });

  it('collapses whitespace and case', () => {
    expect(normaliseCity('  RIYADH  CITY ')).toBe('riyadh city');
  });
});

describe('parseStoreZones — any-scope rows survive', () => {
  it('keeps country-only wildcard rows (the PR 2a data-loss bug)', () => {
    expect(parseStoreZones([{ country: 'SA' }])).toEqual([{ country: 'SA' }]);
  });

  it('keeps region wildcard rows', () => {
    expect(parseStoreZones([{ country: 'SA', region: 'منطقة الرياض' }])).toEqual(
      [{ country: 'SA', region: 'منطقة الرياض' }],
    );
  });

  it('keeps legacy city rows unchanged', () => {
    expect(
      parseStoreZones([{ city: 'الرياض', districts: ['الملقا', ' '] }]),
    ).toEqual([{ city: 'الرياض', districts: ['الملقا'] }]);
  });

  it('drops rows with no scope at all', () => {
    expect(parseStoreZones([{}, { note: 'just a note' }, null, 'junk'])).toEqual(
      [],
    );
  });

  it('returns [] for non-array junk', () => {
    expect(parseStoreZones(null)).toEqual([]);
    expect(parseStoreZones('zones')).toEqual([]);
  });
});

describe('matchAddressToStoreZones — legacy behaviour preserved', () => {
  it('non-fast-delivery always passes', () => {
    expect(match({ city: 'تبوك' }, [{ city: 'الرياض' }], false)).toEqual({
      ok: true,
    });
  });

  it('no zones → legacy single-city fallback (match)', () => {
    expect(match({ city: 'الرياض' }, null)).toEqual({ ok: true });
  });

  it('no zones → legacy single-city fallback (mismatch)', () => {
    expect(match({ city: 'جدة' }, null)).toEqual({
      ok: false,
      reason: 'city_mismatch',
    });
  });

  it('city zone, whole city → match any district', () => {
    expect(
      match({ city: 'الرياض', district: 'السويدي' }, [{ city: 'الرياض' }]),
    ).toEqual({ ok: true });
  });

  it('district whitelist → in-list matches, out-of-list rejects with district_mismatch', () => {
    const zones = [{ city: 'الرياض', districts: ['الملقا', 'العليا'] }];
    expect(match({ city: 'الرياض', district: 'الملقا' }, zones)).toEqual({
      ok: true,
    });
    expect(match({ city: 'الرياض', district: 'السويدي' }, zones)).toEqual({
      ok: false,
      reason: 'district_mismatch',
    });
  });

  it('zoned store ignores the legacy city column', () => {
    // Store.city is الرياض but zones say جدة only.
    expect(match({ city: 'الرياض' }, [{ city: 'جدة' }])).toEqual({
      ok: false,
      reason: 'city_mismatch',
    });
  });

  it('normalization parity applies to the city gate (جده matches stored جدة)', () => {
    expect(match({ city: 'جده' }, [{ city: 'جدة' }])).toEqual({ ok: true });
  });

  it('normalization parity applies to district whitelists (tashkeel-stored vs plain-typed)', () => {
    expect(
      match({ city: 'الرياض', district: 'العليا' }, [
        { city: 'الرياض', districts: ['العُلْيَا'] },
      ]),
    ).toEqual({ ok: true });
  });
});

describe('matchAddressToStoreZones — wildcards (PR 4)', () => {
  it('{ country } matches any address in that country', () => {
    const zones = [{ country: 'SA' }];
    expect(
      match({ country: 'SA', city: 'تبوك', district: 'المروج' }, zones),
    ).toEqual({ ok: true });
    expect(match({ country: 'sa', city: 'جدة' }, zones)).toEqual({ ok: true });
  });

  it('{ country } rejects an address in another country', () => {
    expect(match({ country: 'KW', city: 'السالمية' }, [{ country: 'SA' }])).toEqual(
      { ok: false, reason: 'city_mismatch' },
    );
  });

  it('{ country } does NOT match an address with no country (conservative)', () => {
    expect(match({ city: 'الرياض' }, [{ country: 'SA' }])).toEqual({
      ok: false,
      reason: 'city_mismatch',
    });
  });

  it('{ country, region } matches any city in the region', () => {
    const zones = [{ country: 'SA', region: 'منطقة الرياض' }];
    expect(
      match(
        { country: 'SA', region: 'منطقة الرياض', city: 'الخرج' },
        zones,
      ),
    ).toEqual({ ok: true });
  });

  it('{ country, region } rejects an address in another region', () => {
    const zones = [{ country: 'SA', region: 'منطقة الرياض' }];
    expect(
      match(
        { country: 'SA', region: 'منطقة مكة المكرمة', city: 'جدة' },
        zones,
      ),
    ).toEqual({ ok: false, reason: 'city_mismatch' });
  });

  it('region gate uses Arabic folding (teh marbuta variant of the stored name)', () => {
    const zones = [{ country: 'SA', region: 'المنطقة الشرقية' }];
    expect(
      match(
        { country: 'SA', region: 'المنطقه الشرقيه', city: 'الدمام' },
        zones,
      ),
    ).toEqual({ ok: true });
  });

  it('pure country wildcard can admit an address with country but no city', () => {
    expect(match({ country: 'SA' }, [{ country: 'SA' }])).toEqual({
      ok: true,
    });
  });

  it('{ country, city } gates on both — same-name city in another country rejects', () => {
    const zones = [{ country: 'SA', city: 'الرياض' }];
    expect(match({ country: 'SA', city: 'الرياض' }, zones)).toEqual({
      ok: true,
    });
    // Hypothetical same-name city in Kuwait must NOT co-match.
    expect(match({ country: 'KW', city: 'الرياض' }, zones)).toEqual({
      ok: false,
      reason: 'city_mismatch',
    });
  });

  it('city-bearing zone with no country still matches a countryless address (legacy rows)', () => {
    expect(match({ city: 'الرياض' }, [{ city: 'الرياض' }])).toEqual({
      ok: true,
    });
  });

  it('mixed scopes: ANY zone matching admits', () => {
    const zones = [
      { country: 'KW' },
      { country: 'SA', region: 'منطقة الرياض' },
      { city: 'جدة', districts: ['الشاطئ'] },
    ];
    expect(match({ country: 'KW', city: 'حولي' }, zones)).toEqual({
      ok: true,
    });
    expect(
      match({ country: 'SA', region: 'منطقة الرياض', city: 'الدرعية' }, zones),
    ).toEqual({ ok: true });
    expect(match({ country: 'SA', city: 'جدة', district: 'الشاطئ' }, zones)).toEqual(
      { ok: true },
    );
    expect(match({ country: 'SA', city: 'أبها' }, zones)).toEqual({
      ok: false,
      reason: 'city_mismatch',
    });
  });

  it('district-restricted city match still reports district_mismatch over wildcard misses', () => {
    const zones = [
      { country: 'KW' },
      { city: 'الرياض', districts: ['الملقا'] },
    ];
    expect(
      match({ country: 'SA', city: 'الرياض', district: 'السويدي' }, zones),
    ).toEqual({ ok: false, reason: 'district_mismatch' });
  });
});
