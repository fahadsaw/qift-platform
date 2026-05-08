// Canonical phone-number normalization.
//
// One helper used by every callsite that touches a phone string —
// auth.service.register, otp.service.send, users.service search /
// check, etc. — so a phone typed in any of these forms ends up at
// the same E.164 canonical form before it touches the database:
//
//   "0501234567"          → "+966501234567"   (default-country-fill)
//   "501234567"           → "+966501234567"   (default-country-fill)
//   "966501234567"        → "+966501234567"   (digits-only with CC)
//   "+966501234567"       → "+966501234567"   (already canonical)
//   "+966 50 123 4567"    → "+966501234567"   (whitespace stripped)
//   "00966501234567"      → "+966501234567"   (international prefix)
//   "+9660501234567"      → "+966501234567"   (rogue 0 between CC + local)
//
// The default country (Saudi Arabia, +966) is the assumption when
// neither a `+` nor a recognisable country-code prefix is present —
// because today every signup happens in Saudi. The defaultCountry
// parameter exists so a future GCC expansion (or an explicit `dial`
// param threading down from the frontend) can override.
//
// Returns null when the input cannot be coerced to a valid E.164.
// Callers should treat null as "reject — bad phone shape".

const SUPPORTED_COUNTRIES = {
  // Saudi Arabia: 9-digit local mobile starting with 5 (so total +966
  // 5XXXXXXXX → 13 chars including +). Strict because SA mobiles
  // have a fixed shape and bad mobile numbers don't deliver SMS.
  SA: { dial: '966', mobileLocal: /^5\d{8}$/ },
  AE: { dial: '971', mobileLocal: /^5\d{8}$/ },
  KW: { dial: '965', mobileLocal: /^[569]\d{7}$/ },
  QA: { dial: '974', mobileLocal: /^[3567]\d{7}$/ },
  BH: { dial: '973', mobileLocal: /^[36]\d{7}$/ },
  OM: { dial: '968', mobileLocal: /^[79]\d{7}$/ },
} as const;

export type CountryCode = keyof typeof SUPPORTED_COUNTRIES;

const ALL_DIAL_CODES = Object.values(SUPPORTED_COUNTRIES).map((c) => c.dial);

// Loose E.164 envelope: + followed by 8–15 digits, leading digit not 0.
// Used as the final sanity check on whatever we produce.
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export type NormalizePhoneOptions = {
  // Country to assume when the input has no country-code prefix.
  // Default = SA because that's the launch market.
  defaultCountry?: CountryCode;
};

export function normalizePhone(
  raw: string | null | undefined,
  opts: NormalizePhoneOptions = {},
): string | null {
  if (!raw) return null;
  const defaultCountry = opts.defaultCountry ?? 'SA';
  const defaultDial = SUPPORTED_COUNTRIES[defaultCountry].dial;

  // Step 1 — strip every character that isn't a digit or a +. Users
  // paste with spaces, dashes, parens, dots, NBSPs; we throw all of
  // it away. We only keep the FIRST `+` since legitimate E.164 has
  // exactly one and never anywhere except position 0.
  let s = String(raw).replace(/[^\d+]/g, '');
  // Collapse multiple `+` to one at position 0.
  if (s.includes('+')) {
    s = '+' + s.replace(/\+/g, '');
  }

  if (!s) return null;

  // Step 2 — international `00` prefix is the same as `+`. Some users
  // type `00966...` instead of `+966...`. Normalise.
  if (s.startsWith('00')) {
    s = '+' + s.slice(2);
  }

  // Step 3 — if there's a `+`, validate it parses as E.164 and bail.
  // This handles the canonical case AND the duplicate-country-code
  // case that we strip below if needed.
  if (s.startsWith('+')) {
    let candidate = s;
    // Defensive: a rogue 0 immediately after the country code (e.g.
    // "+9660501234567") is a common mis-paste. Strip it for known
    // dial codes only.
    for (const dial of ALL_DIAL_CODES) {
      const withRogueZero = `+${dial}0`;
      if (candidate.startsWith(withRogueZero)) {
        candidate = `+${dial}${candidate.slice(withRogueZero.length)}`;
        break;
      }
    }
    return E164_REGEX.test(candidate) ? candidate : null;
  }

  // Step 4 — no `+`. Could be:
  //   (a) digits-only with a recognised country code prefix
  //   (b) local-format with a leading 0 (Saudi 05XXXXXXXX style)
  //   (c) local-format without a leading 0 (5XXXXXXXX)
  //   (d) garbage
  //
  // Try (a) first — if the digits start with a known country dial,
  // the user typed an international number without the +. Just
  // reattach the +.
  for (const dial of ALL_DIAL_CODES) {
    if (s.startsWith(dial)) {
      // Drop any leading 0 between the dial code and the local part.
      let rest = s.slice(dial.length);
      if (rest.startsWith('0')) rest = rest.replace(/^0+/, '');
      const candidate = `+${dial}${rest}`;
      return E164_REGEX.test(candidate) ? candidate : null;
    }
  }

  // (b) + (c): local format, default country fill. Strip leading 0s
  // and prepend the default dial code.
  const localDigits = s.replace(/^0+/, '');
  if (!localDigits) return null;
  const candidate = `+${defaultDial}${localDigits}`;
  return E164_REGEX.test(candidate) ? candidate : null;
}

// Verify the shape of an E.164 number is plausible for the given
// country's mobile range. Used after normalizePhone() to reject
// landlines / clearly-invalid numbers before we burn an OTP send.
// Returns null on success, or a short stable code for the caller.
export function validateMobile(
  e164: string | null,
  country?: CountryCode,
): null | 'phone_invalid' | 'phone_not_mobile' {
  if (!e164 || !E164_REGEX.test(e164)) return 'phone_invalid';
  // Auto-detect country from the dial code if the caller didn't tell us.
  let detected: CountryCode | null = country ?? null;
  if (!detected) {
    for (const [code, cfg] of Object.entries(SUPPORTED_COUNTRIES)) {
      if (e164.startsWith(`+${cfg.dial}`)) {
        detected = code as CountryCode;
        break;
      }
    }
  }
  if (!detected) {
    // Unknown country; we don't have a mobile-shape rule, so accept.
    return null;
  }
  const cfg = SUPPORTED_COUNTRIES[detected];
  const local = e164.slice(`+${cfg.dial}`.length);
  return cfg.mobileLocal.test(local) ? null : 'phone_not_mobile';
}
