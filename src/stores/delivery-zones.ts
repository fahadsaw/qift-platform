// Coverage matcher. Single source of truth for "does store X
// deliver to address Y?" — used by GiftsService.confirmAddress to
// reject deliveries that fall outside the merchant's configured
// zones, and by snapshotting on order creation.
//
// The frontend editor at /store-dashboard/coverage emits the same
// shape via PATCH /stores/:id { deliveryZones }, which is the ONLY
// writer for this column. Anything else needs to go through the
// same parseStoreZones() shape-check before being persisted.

// Single zone — either a whole city ("we deliver everywhere in
// Riyadh") or a city + a district whitelist ("we deliver only to
// these 9 northern districts"). `note` is operator-facing and
// never read by the matcher.
export type DeliveryZone = {
  city: string;
  districts?: string[];
  note?: string;
};

// Why a match failed. Surfaced verbatim so callers can render a
// localised, address-specific error.
export type CoverageMatch =
  | { ok: true }
  | { ok: false; reason: 'city_mismatch' | 'district_mismatch' };

// Parse the JSON column into a clean array. Bad rows are dropped
// instead of throwing — we never want a corrupted zone entry to
// 500 the dashboard. The dashboard editor and the seed both write
// canonical shapes, but we tolerate junk in the legacy / hand-
// edited case.
export function parseStoreZones(value: unknown): DeliveryZone[] {
  if (!Array.isArray(value)) return [];
  const out: DeliveryZone[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const city = typeof r.city === 'string' ? r.city.trim() : '';
    if (!city) continue;
    const districts = Array.isArray(r.districts)
      ? r.districts
          .filter((d): d is string => typeof d === 'string')
          .map((d) => d.trim())
          .filter(Boolean)
      : undefined;
    const note = typeof r.note === 'string' ? r.note : undefined;
    out.push(
      districts && districts.length > 0
        ? { city, districts, note }
        : { city, note },
    );
  }
  return out;
}

// Lower-case, NFKC, strip Arabic diacritics, collapse spaces,
// strip the leading definite article. Same algorithm used by
// users.service.ts for canDeliverFast — kept here as the
// authoritative version since coverage matching is the harder
// case.
export function normaliseCity(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/^ال/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Coverage check. Returns ok=true when the address is reachable
// via the store's configured zones (or the legacy single-city
// fallback). The matcher only enforces coverage for fast-delivery
// products today — couriered (non-perishable) products can still
// ship anywhere via standard shipping; that's a future feature
// and not what's failing in production.
//
// Fallback rule: if the store has NO deliveryZones rows, we fall
// back to the legacy `Store.city` column (city must match exactly).
// If the store has zones, those are authoritative — the legacy
// city is ignored.
export function matchAddressToStoreZones(
  address: { city: string | null; district: string | null },
  store: { city: string; deliveryZones: unknown },
  isFastDelivery: boolean,
): CoverageMatch {
  if (!isFastDelivery) return { ok: true };

  const addrCity = normaliseCity(address.city ?? '');
  const addrDistrict = normaliseCity(address.district ?? '');
  if (!addrCity) return { ok: false, reason: 'city_mismatch' };

  const zones = parseStoreZones(store.deliveryZones);
  if (zones.length === 0) {
    // Legacy / pre-v2 store: single-city fallback.
    return normaliseCity(store.city) === addrCity
      ? { ok: true }
      : { ok: false, reason: 'city_mismatch' };
  }

  const cityMatchedZones = zones.filter(
    (z) => normaliseCity(z.city) === addrCity,
  );
  if (cityMatchedZones.length === 0) {
    return { ok: false, reason: 'city_mismatch' };
  }

  // City matched. If ANY of the city-matched zones is open city-
  // wide (no districts whitelist), we deliver anywhere in the
  // city. Otherwise the address district must appear in at least
  // one matched zone's whitelist.
  const cityWideOpen = cityMatchedZones.some(
    (z) => !z.districts || z.districts.length === 0,
  );
  if (cityWideOpen) return { ok: true };

  for (const zone of cityMatchedZones) {
    const districts = zone.districts ?? [];
    if (districts.map(normaliseCity).includes(addrDistrict)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'district_mismatch' };
}
