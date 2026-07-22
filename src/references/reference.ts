// Canonical reference grammar (Track A.5 / CANONICAL_REFERENCE_ARCHITECTURE.md).
//
// Every public, human-readable identifier Qift issues comes from this
// module — one grammar, one alphabet, one normalizer. Nothing else in
// the codebase may mint a customer-facing reference.
//
// Two kinds:
//   RANDOM      QX-XXXX-XXXX  — operational references (orders,
//               campaigns, gifts, fulfillment). Random, NOT sequential:
//               sequential numbers leak volumes and invite enumeration.
//               8 chars over a 31-symbol alphabet ≈ 8.5e11 combinations.
//   SEQUENTIAL  QC-YYYY-NNNNN — legal documents only (Qift's own
//               service-fee invoice), where the law wants an unbroken
//               series. Allocation is transactional via NumberSequence
//               (see invoice service) — this module only formats/parses.
//
// References are NOT authentication secrets. Possession of a reference
// grants nothing; every lookup stays behind ownership / org / merchant /
// ops authorization. (Claim links remain 256-bit hashed tokens — a
// different mechanism for a different job.)
//
// Alphabet matches the beta-code house pattern: no 0/O/1/I/L, so a
// reference survives handwriting, phone calls, and Arabic-keyboard
// typos. Stored UPPERCASE with canonical dashes; matched
// case-insensitively with dashes/spaces optional (see normalizeReference).

import { randomInt } from 'node:crypto';

export const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type ReferenceKind = 'random' | 'sequential' | 'reserved';

// The prefix registry — the single source of truth for what exists.
// Adding a prefix here is an architecture decision; see the doc.
export const REFERENCE_PREFIXES = {
  // Personal order — buyer-facing purchase reference.
  QP: { kind: 'random', object: 'personal_order' },
  // Business campaign — the corporate purchase reference.
  QB: { kind: 'random', object: 'business_campaign' },
  // Recipient gift — one recipient's journey inside a campaign.
  QG: { kind: 'random', object: 'recipient_gift' },
  // Merchant fulfillment order — what the merchant works and quotes.
  QF: { kind: 'random', object: 'merchant_fulfillment' },
  // Qift service-fee invoice — SEQUENTIAL legal series (agent model:
  // this is the ONLY invoice number Qift generates for itself; a
  // merchant's goods-invoice number is the merchant's to issue).
  QC: { kind: 'sequential', object: 'qift_service_invoice' },
  // Settlement batch reference — ACTIVE as of Reference Constitution
  // v2.0 (the QS-activation amendment) + Settlement Constitution §14:
  // random operational, ONE per batch, allocated only at batch
  // assembly, immutable across retries, renewed on re-assembly, never
  // on simulations (SC §30.2). Allocation lives in the settlement
  // engine — nothing else may mint a QS.
  QS: { kind: 'random', object: 'settlement_batch' },
  // Credit note reference — ACTIVE as of Reference Constitution v3.0
  // (the QN-activation amendment): random operational, ONE per credit
  // note, allocated at issuance, immutable forever. The credit note is
  // a FIRST-CLASS financial document (canonical JSON + hash + replay +
  // audit + invoice/statement relationships). Allocation lives in the
  // settlement refunds service — nothing else may mint a QN.
  QN: { kind: 'random', object: 'credit_note' },
  // Qift credit-note LEGAL series — ACTIVE as of Reference
  // Constitution v4.0: SEQUENTIAL (QD-YYYY-NNNNN, NumberSequence-
  // allocated, gap-free), Qift's OWN service-fee credit notes only
  // (agent model — a merchant's credit-note number is theirs to
  // issue, never QD). QN remains the operational reference.
  QD: { kind: 'sequential', object: 'qift_credit_note' },
} as const satisfies Record<string, { kind: ReferenceKind; object: string }>;

export type ReferencePrefix = keyof typeof REFERENCE_PREFIXES;

const RANDOM_GROUP = 4;
const RANDOM_BODY_LENGTH = RANDOM_GROUP * 2;

// QX-XXXX-XXXX for random refs; QC-YYYY-NNNNN (zero-padded, series =
// issue year) for the sequential invoice series.
const RANDOM_BODY_RE = new RegExp(
  `^[${REFERENCE_ALPHABET}]{${RANDOM_BODY_LENGTH}}$`,
);
// Year constrained to 20xx: the compact (dashless) form is otherwise
// ambiguous about where the year ends. Revisit in the year 2100.
const SEQUENTIAL_BODY_RE = /^(20\d{2})(\d{1,7})$/;

function randomGroup(): string {
  let out = '';
  for (let i = 0; i < RANDOM_GROUP; i++) {
    out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return out;
}

/** Mint a candidate random reference, e.g. `QB-7XKM-3NPQ`. */
export function generateReference(prefix: ReferencePrefix): string {
  const entry = REFERENCE_PREFIXES[prefix];
  if (entry.kind !== 'random') {
    throw new Error(
      `reference_prefix_not_random: ${prefix} is ${entry.kind} — ` +
        (entry.kind === 'sequential'
          ? 'allocate it through the NumberSequence path'
          : 'reserved for a future track'),
    );
  }
  return `${prefix}-${randomGroup()}-${randomGroup()}`;
}

/** Format a sequential legal number, e.g. formatSequentialReference('QC', 2026, 7) === 'QC-2026-00007'. */
export function formatSequentialReference(
  prefix: ReferencePrefix,
  seriesYear: number,
  value: number,
): string {
  if (REFERENCE_PREFIXES[prefix].kind !== 'sequential') {
    throw new Error(`reference_prefix_not_sequential: ${prefix}`);
  }
  if (!Number.isInteger(seriesYear) || seriesYear < 2020 || seriesYear > 2099) {
    throw new Error(`reference_series_year_invalid: ${seriesYear}`);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`reference_sequence_value_invalid: ${value}`);
  }
  return `${prefix}-${seriesYear}-${String(value).padStart(5, '0')}`;
}

/**
 * Normalize free-form user input to the canonical stored form, or null
 * if it isn't a well-formed reference. Case-insensitive; dashes,
 * spaces, and any punctuation are ignored, so "qb 7xkm 3npq",
 * "QB7XKM3NPQ" and "QB-7XKM-3NPQ" all normalize identically.
 */
export function normalizeReference(input: string): string | null {
  if (!input) return null;
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = (Object.keys(REFERENCE_PREFIXES) as ReferencePrefix[]).find(
    (p) => compact.startsWith(p),
  );
  if (!prefix) return null;
  const body = compact.slice(prefix.length);
  const entry = REFERENCE_PREFIXES[prefix];

  if (entry.kind === 'sequential') {
    const m = SEQUENTIAL_BODY_RE.exec(body);
    if (!m) return null;
    const value = Number(m[2]);
    if (value < 1) return null;
    return formatSequentialReference(prefix, Number(m[1]), value);
  }

  // random + reserved share the random shape. (QS has been ACTIVE
  // since RC v2.0 — it parses and generates like every random kind.)
  if (!RANDOM_BODY_RE.test(body)) return null;
  return `${prefix}-${body.slice(0, RANDOM_GROUP)}-${body.slice(RANDOM_GROUP)}`;
}

/** True iff the string is already in canonical stored form. */
export function isCanonicalReference(value: string): boolean {
  return normalizeReference(value) === value;
}

const MAX_ALLOCATION_ATTEMPTS = 5;

/**
 * Allocate a unique random reference. `isTaken` checks the DB; the
 * bounded retry mirrors the gift-post slug pattern. At current scales a
 * single collision is already astronomically unlikely — exhaustion
 * means something is broken, so it throws rather than degrading.
 *
 * NOTE: callers must still hold a UNIQUE index on the column and treat
 * an insert-time P2002 as one more retry — the check-then-insert gap is
 * closed by the constraint, not this loop.
 */
export async function allocateReference(
  prefix: ReferencePrefix,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const candidate = generateReference(prefix);
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`reference_allocation_exhausted: ${prefix}`);
}
