// Phase 7.1 — quiet-hours pure helper.
//
// Decides "is `now` inside this user's quiet window?" given the
// stored preferences. Used by the orchestrator to defer alert
// channels (push / email / SMS) into the digest queue when the
// user has explicitly asked not to be disturbed.
//
// Pure functions only — no Prisma, no Nest. Unit-testable.
//
// Quiet hours model:
//   - Stored as "HH:MM" 24-hour strings in a named IANA timezone.
//   - Both `start` and `end` must be set; half-configured states
//     are rejected at the service layer (this module assumes a
//     valid pair).
//   - Crossing midnight is supported: start=22:00 end=08:00 means
//     "from 22:00 today to 08:00 tomorrow (LOCAL time)".
//   - start == end means "always quiet" (a full 24-hour mute).
//     Probably an extreme user choice but legitimate; the model
//     supports it without special casing.
//
// Timezone discipline:
//   - The `now` instant is a UTC Date.
//   - We project `now` into the user's chosen timezone via
//     Intl.DateTimeFormat (no third-party date library, no DST
//     hand-rolling). This is the only correct way — KSA is
//     non-DST, but a future user in Cairo / Istanbul / London
//     would otherwise read quiet-hours off by an hour twice a
//     year.

export type QuietHoursConfig = {
  // "HH:MM" 24-hour. Null in both fields = no quiet hours.
  start: string | null;
  end: string | null;
  // IANA timezone (e.g. "Asia/Riyadh", "Europe/Istanbul").
  timezone: string;
};

// Returns false when:
//   - quiet hours aren't configured (one or both ends null)
//   - the strings are malformed (HH:MM regex fails)
//   - the timezone is unrecognised by the runtime ICU tables
// In all "I don't know" cases we DON'T block — the safer default
// is to deliver real-time. False-positive quiet-hours suppression
// is much worse than false-negative.
export function inQuietHours(config: QuietHoursConfig, now: Date): boolean {
  if (!config.start || !config.end) return false;

  const startMin = parseHhmmToMinutes(config.start);
  const endMin = parseHhmmToMinutes(config.end);
  if (startMin === null || endMin === null) return false;

  // Same minute on both sides means "always quiet" — a full 24
  // hour mute. Return true unconditionally; the projection below
  // would also resolve to true but skipping the projection saves
  // a TZ format call.
  if (startMin === endMin) return true;

  const nowMin = projectMinutesInZone(now, config.timezone);
  if (nowMin === null) return false;

  if (startMin < endMin) {
    // Same-day window — e.g. 13:00 → 14:00 (siesta).
    return nowMin >= startMin && nowMin < endMin;
  }
  // Crosses midnight — e.g. 22:00 → 08:00. Inside the window when
  // EITHER `nowMin >= startMin` (still tonight) OR `nowMin < endMin`
  // (already tomorrow morning).
  return nowMin >= startMin || nowMin < endMin;
}

// ── Internals ──────────────────────────────────────────────────

// "HH:MM" → minutes since midnight, or null when malformed.
// Accepts H:MM, HH:M, HH:MM. Out-of-range values reject.
function parseHhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Project `instant` into the named timezone and return minutes
// since local midnight, or null when the timezone is invalid.
// Uses Intl.DateTimeFormat — the runtime-correct way; no library.
function projectMinutesInZone(instant: Date, tz: string): number | null {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    });
  } catch {
    // Unknown timezone identifier — Intl throws RangeError. We
    // treat this as "I don't know" and refuse to block delivery.
    return null;
  }
  const parts = fmt.formatToParts(instant);
  let h: number | null = null;
  let m: number | null = null;
  for (const p of parts) {
    if (p.type === 'hour') h = Number.parseInt(p.value, 10);
    if (p.type === 'minute') m = Number.parseInt(p.value, 10);
  }
  if (h === null || m === null) return null;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  // Intl.DateTimeFormat sometimes emits "24" for midnight in
  // en-GB; normalise to 0 so the comparison works.
  if (h === 24) h = 0;
  return h * 60 + m;
}
