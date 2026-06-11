// Corporate console seat roles (Corporate Foundation PR 1).
//
// These are ORG-PLANE roles — the 2–5 humans who run a company's
// campaigns. They are a separate permission plane from both the
// consumer User.role and the Qift ops-role catalog, and the planes
// never inherit (Corporate Core v2 §7): a Qift admin has no org
// access without a seat; an OrgUser has no Qift-ops powers.
//
//   owner    — everything: seats, org profile, future billing.
//   admin    — rosters + campaigns (create/submit).
//   approver — approves campaigns + funding visibility (the
//              maker–checker counterparty; an approver who is also
//              the creator of a campaign cannot approve it — that
//              rule lands with the campaign PR).
//   viewer   — read-only reports.
//
// `owner` implicitly satisfies every requirement; other roles are
// explicit-list only (no hierarchy ladder — explicitness beats
// cleverness in authz).

export const ORG_ROLES = ['owner', 'admin', 'approver', 'viewer'] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

// Does a seat with `held` satisfy a route that allows `allowed`?
// Owner passes everything; otherwise membership in the explicit
// allow-list.
export function orgRoleSatisfies(
  held: string,
  allowed: readonly OrgRole[],
): boolean {
  if (held === 'owner') return true;
  return (allowed as readonly string[]).includes(held);
}
