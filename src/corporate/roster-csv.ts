// Roster CSV parsing + import policy (Corporate Foundation PR 2).
//
// Pure functions, no I/O — RosterService feeds the raw CSV text in
// and persists what comes out. Three layers:
//
//   1. parseCsv        — small RFC-4180-ish parser (quotes, CRLF,
//                        BOM). No dependency: the roster shape is
//                        narrow and pinned by tests, which beats
//                        auditing a csv package for this PR.
//   2. Header policy   — maps known header aliases (EN + AR) to
//                        roster fields, REJECTS the whole file if
//                        any address-like column is present, and
//                        reports unmapped columns as ignored.
//   3. Row validation  — name + at least one valid channel; phone
//                        through the canonical normalizePhone (+
//                        mobile-shape check); email lowercased.
//
// THE ADDRESS-COLUMN REJECTION IS A PRIVACY GATE, NOT A
// CONVENIENCE. The company must never supply employee addresses
// (Corporate Core v2 §3/§5): recipients give Qift their address
// themselves at claim time. A CSV with an address column is refused
// outright — not silently dropped — so the uploader learns the rule
// instead of believing the data went through.

import { normalizePhone, validateMobile } from '../auth/phone-normalize';

// Caps. Pilot scale is hundreds of rows; these are generous while
// still bounding a synchronous request. Larger imports are a C2
// concern (not approved scope) and would move to a job.
export const MAX_CSV_BYTES = 512 * 1024;
export const MAX_ROSTER_ROWS = 2000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Layer 1: CSV parsing ────────────────────────────────────────────

// Parse CSV text into rows of cells. Handles quoted fields
// (embedded commas, quotes doubled per RFC 4180, embedded
// newlines), CR/LF/CRLF line ends, and a UTF-8 BOM. Wholly-empty
// lines are dropped.
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    row.push(cell);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushCell();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  // Trailing cell/row without a final newline.
  if (cell !== '' || row.length > 0) pushRow();
  return rows;
}

// ── Layer 2: header policy ──────────────────────────────────────────

export type RosterField =
  | 'fullName'
  | 'email'
  | 'phone'
  | 'department'
  | 'employeeRef';

// Known header aliases, English + Arabic, compared after
// normalisation (lowercase, trimmed, internal whitespace/_/-
// collapsed). Keep this list boring and explicit.
const HEADER_ALIASES: Record<string, RosterField> = {
  // fullName
  name: 'fullName',
  fullname: 'fullName',
  'full name': 'fullName',
  'employee name': 'fullName',
  الاسم: 'fullName',
  'اسم الموظف': 'fullName',
  'الاسم الكامل': 'fullName',
  // email
  email: 'email',
  'email address': 'email',
  'work email': 'email',
  البريد: 'email',
  'البريد الإلكتروني': 'email',
  'البريد الالكتروني': 'email',
  ايميل: 'email',
  إيميل: 'email',
  // phone
  phone: 'phone',
  mobile: 'phone',
  'phone number': 'phone',
  'mobile number': 'phone',
  جوال: 'phone',
  الجوال: 'phone',
  'رقم الجوال': 'phone',
  الهاتف: 'phone',
  'رقم الهاتف': 'phone',
  // department
  department: 'department',
  dept: 'department',
  team: 'department',
  القسم: 'department',
  الإدارة: 'department',
  الادارة: 'department',
  // employeeRef
  'employee id': 'employeeRef',
  employeeid: 'employeeRef',
  'employee ref': 'employeeRef',
  'staff id': 'employeeRef',
  'الرقم الوظيفي': 'employeeRef',
  'رقم الموظف': 'employeeRef',
};

// Address-like header fragments (EN + AR). Substring match on the
// normalised header — broad on purpose: a false positive costs the
// uploader a column rename; a false negative ingests employee
// addresses we must never hold.
const FORBIDDEN_HEADER_FRAGMENTS: readonly string[] = [
  'address',
  'street',
  'city',
  'district',
  'region',
  'postal',
  'zip',
  'po box',
  'pobox',
  'location',
  'building',
  'apartment',
  'villa',
  'عنوان',
  'العنوان',
  'شارع',
  'مدينة',
  'المدينة',
  'حي',
  'الحي',
  'منطقة',
  'المنطقة',
  'رمز بريدي',
  'الرمز البريدي',
  'صندوق بريد',
  'موقع',
  'مبنى',
  'شقة',
  'فيلا',
];

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type HeaderPlan = {
  // column index → roster field, for mapped columns only.
  mapping: Map<number, RosterField>;
  ignoredColumns: string[];
};

export type HeaderRejection = {
  code: 'roster_address_columns_forbidden' | 'roster_headers_unusable';
  // For the forbidden case: the offending header names, verbatim,
  // so the org admin knows exactly what to remove.
  columns: string[];
};

export function planHeaders(
  headerRow: string[],
): { ok: true; plan: HeaderPlan } | { ok: false; rejection: HeaderRejection } {
  const forbidden: string[] = [];
  const mapping = new Map<number, RosterField>();
  const ignored: string[] = [];
  const seen = new Set<RosterField>();

  headerRow.forEach((raw, idx) => {
    const norm = normalizeHeader(raw);
    if (!norm) return;
    if (FORBIDDEN_HEADER_FRAGMENTS.some((f) => norm.includes(f))) {
      forbidden.push(raw.trim());
      return;
    }
    const field = HEADER_ALIASES[norm];
    // First mapped column wins per field; duplicates are ignored
    // (and reported) rather than guessed at.
    if (field && !seen.has(field)) {
      seen.add(field);
      mapping.set(idx, field);
    } else {
      ignored.push(raw.trim());
    }
  });

  if (forbidden.length > 0) {
    return {
      ok: false,
      rejection: {
        code: 'roster_address_columns_forbidden',
        columns: forbidden,
      },
    };
  }
  if (!seen.has('fullName') || (!seen.has('email') && !seen.has('phone'))) {
    return {
      ok: false,
      rejection: { code: 'roster_headers_unusable', columns: [] },
    };
  }
  return { ok: true, plan: { mapping, ignoredColumns: ignored } };
}

// ── Layer 3: row validation ─────────────────────────────────────────

export type RosterRow = {
  // 1-based line position in the file (header = line 1) — carried
  // so the service can report DB-level duplicate skips by line.
  line: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  employeeRef: string | null;
};

export type SkippedRow = {
  // 1-based line position in the parsed file (header = line 1).
  line: number;
  reason:
    | 'name_missing'
    | 'channel_missing'
    | 'phone_invalid'
    | 'email_invalid'
    | 'duplicate_in_file'
    // Added by RosterService, not this parser: the row matches a
    // contact already on the org's active roster.
    | 'duplicate_existing';
};

export type RosterParseResult =
  | {
      ok: true;
      rows: RosterRow[];
      skipped: SkippedRow[];
      ignoredColumns: string[];
    }
  | { ok: false; rejection: HeaderRejection | { code: string; columns?: string[] } };

// Full pipeline: text → validated, deduped roster rows. Dedup here
// covers within-file repeats; RosterService dedups against rows
// already in the DB.
export function parseRoster(text: string): RosterParseResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) {
    return { ok: false, rejection: { code: 'roster_file_too_large' } };
  }
  const table = parseCsv(text);
  if (table.length < 2) {
    return { ok: false, rejection: { code: 'roster_empty' } };
  }
  if (table.length - 1 > MAX_ROSTER_ROWS) {
    return { ok: false, rejection: { code: 'roster_too_many_rows' } };
  }
  const headers = planHeaders(table[0]);
  if (!headers.ok) return { ok: false, rejection: headers.rejection };
  const { mapping, ignoredColumns } = headers.plan;

  const rows: RosterRow[] = [];
  const skipped: SkippedRow[] = [];
  const seenChannels = new Set<string>();

  for (let r = 1; r < table.length; r++) {
    const line = r + 1;
    const raw: Partial<Record<RosterField, string>> = {};
    for (const [idx, field] of mapping) {
      const v = (table[r][idx] ?? '').trim();
      if (v) raw[field] = v;
    }

    const fullName = raw.fullName ?? '';
    if (fullName.length < 2) {
      skipped.push({ line, reason: 'name_missing' });
      continue;
    }

    let email: string | null = null;
    if (raw.email) {
      const lowered = raw.email.toLowerCase();
      if (!EMAIL_REGEX.test(lowered)) {
        skipped.push({ line, reason: 'email_invalid' });
        continue;
      }
      email = lowered;
    }

    let phone: string | null = null;
    if (raw.phone) {
      const e164 = normalizePhone(raw.phone);
      if (!e164 || validateMobile(e164) !== null) {
        skipped.push({ line, reason: 'phone_invalid' });
        continue;
      }
      phone = e164;
    }

    if (!email && !phone) {
      skipped.push({ line, reason: 'channel_missing' });
      continue;
    }

    // Within-file dedup on either channel.
    const keys = [email && `e:${email}`, phone && `p:${phone}`].filter(
      Boolean,
    ) as string[];
    if (keys.some((k) => seenChannels.has(k))) {
      skipped.push({ line, reason: 'duplicate_in_file' });
      continue;
    }
    keys.forEach((k) => seenChannels.add(k));

    rows.push({
      line,
      fullName,
      email,
      phone,
      department: raw.department ?? null,
      employeeRef: raw.employeeRef ?? null,
    });
  }

  return { ok: true, rows, skipped, ignoredColumns };
}
