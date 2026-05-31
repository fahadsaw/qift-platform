// Beta-code + allowlist value normalisation helpers.
//
// Kept as pure functions (no DI, no DB) so they can be unit-tested in
// isolation and reused by both the registration-gate path and the
// admin-management path without pulling in the service.

import { randomBytes } from 'crypto';

// Canonical form for a beta invite code: trimmed + uppercased. Stored
// and looked up in this form so redemption is case-insensitive ("qift"
// === "QIFT") while the unique index stays a plain equality probe.
export function normalizeBetaCode(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

// Unambiguous alphabet for generated codes — no 0/O, no 1/I/L. Avoids
// transcription errors when an operator reads a code to a beta tester.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Generate a human-shareable code like "QIFT-7K9M-3PQR". The `QIFT-`
// prefix makes the code self-identifying; two random 4-char groups give
// 30^8 ≈ 6.5e11 of entropy, far beyond any plausible brute-force given
// the per-call DB lookup + (optional) future rate limiting.
export function generateBetaCode(): string {
  const group = () => {
    const bytes = randomBytes(4);
    let out = '';
    for (let i = 0; i < 4; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  };
  return `QIFT-${group()}-${group()}`;
}

// Allowlist kinds. Exported so the controller + service share one
// definition and TS rejects a typo'd kind at compile time.
export const BETA_ALLOWLIST_KINDS = ['email', 'email_domain', 'phone'] as const;
export type BetaAllowlistKind = (typeof BETA_ALLOWLIST_KINDS)[number];

export function isBetaAllowlistKind(value: string): value is BetaAllowlistKind {
  return (BETA_ALLOWLIST_KINDS as readonly string[]).includes(value);
}

// Lowercase + trim an email for the 'email' allowlist kind. Mirrors the
// canonicalisation auth.service.register applies to body.email, so an
// allowlisted address matches regardless of the casing a registrant
// types.
export function normalizeAllowlistEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Normalise an email-domain allowlist value: lowercase, trim, and strip
// a leading '@' if the operator typed "@example.com". The registration
// path extracts the domain after '@' from the registrant's email and
// compares against this exact value.
export function normalizeAllowlistDomain(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  return lowered.startsWith('@') ? lowered.slice(1) : lowered;
}

// Extract the domain portion of an already-lowercased email, or null if
// the string has no '@' / an empty domain. Used at registration time to
// probe the 'email_domain' allowlist.
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1);
  return domain.length > 0 ? domain : null;
}
