// Claim-token primitives (Corporate Foundation PR 5).
//
// The raw token lives ONLY in the claim URL the recipient holds;
// the database stores its SHA-256. Same posture as password-reset
// links: a database leak yields no usable claim links.

import { createHash, randomBytes } from 'node:crypto';

// 32 random bytes, base64url → ~43 chars, URL-safe.
export function generateClaimToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Masked channel hint shown on the pre-OTP teaser. Deliberately
// stingy: enough for the rightful holder to recognise their own
// channel, useless for identifying anyone else.
//   +966501234567  → "•••••••67"
//   sara@corp.sa   → "s•••@c•••"
export function maskChannel(channel: string, value: string): string {
  if (channel === 'email') {
    const [local, domain] = value.split('@');
    const l = local ? `${local[0]}•••` : '•••';
    const d = domain ? `${domain[0]}•••` : '•••';
    return `${l}@${d}`;
  }
  return `•••••••${value.slice(-2)}`;
}
