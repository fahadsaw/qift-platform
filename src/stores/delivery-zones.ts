// Coverage matcher. Single source of truth for "does store X
// deliver to address Y?" — used by GiftsService.confirmAddress to
// reject deliveries that fall outside the merchant's configured
// zones, by GiftsAutoDefaultService when picking a fallback
// address, and by UsersService.canStoreDeliverToReceiver for the
// pre-payment probe.
//
// The frontend editor at /store-dashboard/coverage emits the same
// shape via PATCH /stores/:id { deliveryZones }, which is the ONLY
// writer for this column. Anything else needs to go through the
// same parseStoreZones() shape-check before being persisted.
//
// PR 4 (Coverage 2b) — WILDCARD SUPPORT. This file now implements
// the full contract documented in qift-ui-v2 lib/deliveryZones.ts
// ("BACKEND CONTRACT" block): a zone may scope to a whole country,
// a whole region, a whole city, or an explicit district whitelist.
// Any unset field is a wildcard, broadest → narrowest:
//
//   { country: 'SA' }                       — all of Saudi Arabia
//   { country: 'SA', region: 'منطقة الرياض' } — all of Riyadh region
//   { country: 'SA', city: 'الرياض' }        — all districts of Riyadh
//   { city: 'الرياض', districts: [...] }     — only those districts
//   { city: 'الرياض' }                       — LEGACY row; matches as
//                                             "country wildcard + city",
//                                             identical to its
//                                             historical behaviour
//
// Match = "ANY zone matches". The closed-beta frontend stopgap
// (qift-ui-v2 PR 2a) that expanded wildcards into explicit city
// rows is reverted in the paired frontend PR once this merges.

// One coverage zone. All fields optional — a row must carry at
// least ONE scope (country / region / city / districts) to survive
// parseStoreZones; a fully-empty row is dropped rather than being
// treated as "matches everything".
export type DeliveryZone = {
  // ISO country code (e.g. 'SA'). Alone → whole-country wildcard;
  // alongside city → disambiguator so a same-name city across two
  // countries doesn't co-match.
  country?: string;
  // Region/emirate name (Arabic, per the frontend catalog). Alone
  // (with optional country) → whole-region wildcard.
  region?: string;
  city?: string;
  districts?: string[];
  // Operator-facing note; never read by the matcher.
  note?: string;
};

// What the matcher needs to know about the recipient address.
// country/region are optional so legacy callers (and Address rows
// predating the region column) degrade gracefully: a missing
// address field simply can't be used as a gate.
export type AddressScope = {
  country?: string | null;
  region?: string | null;
  city: string | null;
  district: string | null;
};

// Why a match failed. Surfaced verbatim so callers can render a
// localised, address-specific error. Wildcard misses collapse into
// 'city_mismatch' — the receiver-facing copy doesn't distinguish
// internal granularity (see gifts.service confirmAddress).
export type CoverageMatch =
  | { ok: true }
  | { ok: false; reason: 'city_mismatch' | 'district_mismatch' };

// Parse the JSON column into a clean array. Bad rows are dropped
// instead of throwing — we never want a corrupted zone entry to
// 500 the dashboard. PR 4: rows are kept when they carry ANY scope
// (previously a missing `city` dropped the row, which silently
// destroyed wildcard coverage at save time).
export function parseStoreZones(value: unknown): DeliveryZone[] {
  if (!Array.isArray(value)) return [];
  const out: DeliveryZone[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const country = typeof r.country === 'string' ? r.country.trim() : '';
    const region = typeof r.region === 'string' ? r.region.trim() : '';
    const city = typeof r.city === 'string' ? r.city.trim() : '';
    const districts = Array.isArray(r.districts)
      ? r.districts
          .filter((d): d is string => typeof d === 'string')
          .map((d) => d.trim())
          .filter(Boolean)
      : undefined;
    const note = typeof r.note === 'string' ? r.note : undefined;

    const hasScope =
      !!country || !!region || !!city || !!(districts && districts.length);
    if (!hasScope) continue;

    out.push({
      ...(country ? { country } : {}),
      ...(region ? { region } : {}),
      ...(city ? { city } : {}),
      ...(districts && districts.length > 0 ? { districts } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }
  return out;
}

// Normalise Arabic / Latin place names for matching. PR 4 brings
// this to FULL PARITY with the frontend's normalizeArabic
// (lib/deliveryZones.ts) — previously the backend folded fewer
// variants, so "جده" (heh) failed to match a stored "جدة" (teh
// marbuta) even though the frontend treated them as equal. That
// class of silent rejection is exactly what this fixes.
//
// Folds, in order:
//   - NFKC (presentation forms → canonical)
//   - lowercase + trim
//   - Tashkeel + tatweel stripped
//   - Hamza-carrier Alef variants (آأإٱ) → ا
//   - Alef Maksura (ى) → Yeh (ي)
//   - Teh Marbuta (ة) → Heh (ه)
//   - Arabic punctuation + directional marks stripped
//   - leading definite article "ال" stripped
//   - leading Latin transliteration prefixes (al-, el-, ar-) stripped
//   - whitespace collapsed
//
// Keep in lock-step with the frontend version — the two sides
// normalise independently and MUST agree.
export function normaliseCity(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[؛؟،‎‏‪-‮]/g, '')
    .replace(/^ال/, '')
    .replace(/^(al-|el-|ar-|el\s|al\s)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Country codes are short ISO strings — case/whitespace-insensitive
// equality is enough (mirrors the frontend's sameCountry).
function sameCountry(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

// Region names use the same Arabic folding as cities.
function sameRegion(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normaliseCity(a ?? '');
  const nb = normaliseCity(b ?? '');
  if (!na || !nb) return false;
  return na === nb;
}

// Coverage check. Returns ok=true when the address is reachable
// via the store's configured zones (or the legacy single-city
// fallback). Only fast-delivery products are coverage-gated today —
// couriered products ship anywhere via standard shipping.
//
// MATCH RULE (mirrors qift-ui-v2 lib/deliveryZones.ts
// matchAddressToZones — keep the two in lock-step):
//   - Pure country/region wildcard zones (no city, no districts)
//     are evaluated first and can match even when the address has
//     no city. A zone gate whose ADDRESS side is missing is
//     conservative: { country:'SA' } does NOT match an address
//     with no country (we'd rather under-promise than green-light
//     an unknown destination).
//   - City-bearing zones gate on country (when both sides have
//     one), region (when both sides have one), city, then the
//     district whitelist. An empty/absent whitelist = whole city.
//
// Fallback rule: if the store has NO deliveryZones rows, we fall
// back to the legacy `Store.city` column. If the store has zones,
// those are authoritative — the legacy city is ignored.
export function matchAddressToStoreZones(
  address: AddressScope,
  store: { city: string; deliveryZones: unknown },
  isFastDelivery: boolean,
): CoverageMatch {
  if (!isFastDelivery) return { ok: true };

  const addrCountry = (address.country ?? '').trim();
  const addrRegion = (address.region ?? '').trim();
  const addrCity = normaliseCity(address.city ?? '');
  const addrDistrict = normaliseCity(address.district ?? '');

  const zones = parseStoreZones(store.deliveryZones);
  if (zones.length === 0) {
    // Legacy / pre-v2 store: single-city fallback (unchanged).
    if (!addrCity) return { ok: false, reason: 'city_mismatch' };
    return normaliseCity(store.city) === addrCity
      ? { ok: true }
      : { ok: false, reason: 'city_mismatch' };
  }

  // Pass 1 — pure wildcard zones (no city, no district whitelist).
  // These can admit an address before we even look at its city.
  for (const zone of zones) {
    if (zone.city || (zone.districts && zone.districts.length > 0)) continue;
    if (zone.country && addrCountry && !sameCountry(zone.country, addrCountry))
      continue;
    if (zone.region && addrRegion && !sameRegion(zone.region, addrRegion))
      continue;
    // Conservative gates: a scoped wildcard needs the address to
    // actually carry the field it scopes on.
    if (zone.country && !addrCountry) continue;
    if (zone.region && !addrRegion) continue;
    return { ok: true };
  }

  // City-bearing zones need an address city to compare against.
  if (!addrCity) return { ok: false, reason: 'city_mismatch' };

  let cityMatched = false;
  for (const zone of zones) {
    // Skip the pure wildcards already evaluated above.
    if (!zone.city && (!zone.districts || zone.districts.length === 0))
      continue;
    if (zone.country && addrCountry && !sameCountry(zone.country, addrCountry))
      continue;
    if (zone.region && addrRegion && !sameRegion(zone.region, addrRegion))
      continue;
    if (zone.city && normaliseCity(zone.city) !== addrCity) continue;

    cityMatched = true;
    const districts = zone.districts ?? [];
    if (districts.length === 0) {
      // Whole-city coverage.
      return { ok: true };
    }
    if (!addrDistrict) {
      // District-restricted zone but the address carries no
      // district — can't safely confirm; try other zones.
      continue;
    }
    if (districts.map(normaliseCity).includes(addrDistrict)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason: cityMatched ? 'district_mismatch' : 'city_mismatch',
  };
}
