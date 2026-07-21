// Internal ops-role capability map.
//
// Layered on top of the coarse `User.role` discriminator
// (user / store / admin). Granular roles let us scale internal
// operations beyond a single "admin" bucket without exploding
// the AdminGuard surface.
//
// Mirrored on the frontend at `qift-ui-v2/lib/opsRoles.ts` — keep
// role codes + permission codes in sync. The frontend mirror is
// presentational only (badge labels, role pickers); the
// authoritative gate is the OpsRoleGuard on the backend.
//
// What we deliberately do NOT model here:
//   - Per-permission expiry / scheduled grants.
//   - Time-bound delegations.
//   - "Break-glass" privilege escalation.
//   - Per-resource ACLs (e.g. "this user can review THIS
//     specific store"). Today every role is platform-wide;
//     resource scoping is a future surface.
//
// SOURCE-OF-TRUTH INVARIANTS (PR B-3a)
// This module no longer maintains a separate string-literal
// universe for identifiers. Instead:
//   - `OPS_ROLES` satisfies `readonly QiftRole[]` from
//     src/rbac/roles.ts — every role name here must exist in the
//     unified RBAC role catalog (a typo or stale name fails to
//     compile).
//   - `OpsPermission` is derived from `OPS_PERMISSIONS`, which
//     satisfies `readonly Permission[]` from
//     src/rbac/permissions.ts — every permission identifier here
//     is verified against the unified RBAC permission catalog.
// Drift between this file and the RBAC catalog on shared
// identifiers is therefore impossible.
//
// CONTENT REMAINS MANUALLY MAINTAINED
// `PERMISSIONS_BY_ROLE` and `SUPER_ADMIN_ALL` are not derived
// from src/rbac/role-map.ts. ops-roles.ts has a behavioural
// contract with the deployed schema (`OpsRoleAssignment` rows
// reference these role codes; live operators hold real grants),
// not with the frontend-shaped RBAC catalog. The drift check
// here covers identifier spelling, not role content. When the
// content needs to change, update both this file and
// src/rbac/role-map.ts to match.

import type { Permission } from '../rbac/permissions';
import type { QiftRole } from '../rbac/roles';

export const OPS_ROLES = [
  // Root. Always has every permission. Use sparingly — bootstrap
  // role for the platform founder + one or two trusted engineers.
  'super_admin',
  // Day-to-day platform operations. Broad read + most writes
  // except finance + trust/safety actions.
  'operations_manager',
  // Settlements, payouts, ledger viewing, finance reports.
  'finance',
  // Onboarding application review (approve / reject /
  // request_changes on Store rows).
  'merchant_review',
  // Read-mostly customer + merchant support. Diagnose orders,
  // resolve address issues; cannot toggle plans / featured /
  // financial state.
  'support',
  // Moderation. Reports queue, account holds, blocks.
  'trust_safety',
  // Fulfillment triage: shipment problems, coverage issues.
  'fulfillment_ops',
  // Read-only access to platform analytics dashboards.
  'analytics_viewer',
] as const satisfies readonly QiftRole[];

export type OpsRole = (typeof OPS_ROLES)[number];

export function isOpsRole(value: string): value is OpsRole {
  return (OPS_ROLES as readonly string[]).includes(value);
}

// Permission catalog. One entry per action surface that needs
// gating. Grouped by domain for readability — actual checks are
// flat strings.
//
// Source-of-truth tuple. Every identifier is verified at compile
// time against the unified RBAC Permission catalog
// (src/rbac/permissions.ts) via `satisfies readonly Permission[]`.
// Parallel to `OPS_ROLES` above: the tuple is the runtime value,
// the `OpsPermission` type is derived from it.
export const OPS_PERMISSIONS = [
  // Store / merchant management.
  'store.review',
  'store.set_plan',
  'store.set_featured',
  'store.set_status',
  'store.read_detail',
  // User management.
  'user.read',
  'user.set_role',
  'user.suspend',
  'user.restore',
  // Permanent account deletion. Granted ONLY to super_admin —
  // trust_safety has suspend + restore but NOT purge. Purge
  // anonymises PII on the User row + hard-deletes identity-PII
  // tables; it's irreversible by design.
  'user.purge',
  'user.assign_ops_role',
  // Finance.
  'finance.read_payouts',
  'finance.record_payout_event',
  'finance.approve_payout',
  // Ledger reconciliation (Track B2 / PE-11): read the document<->ledger
  // missing report and invoke the append-only idempotent repair.
  // Constitutionally required surface (Financial Constitution Ch. 5.6);
  // mismatches carry P0 semantics (Core Invariants #59).
  'finance.reconcile',
  // VAT-facts maker-checker (Track B3 / PE-12): propose/approve/
  // reject merchant VAT facts. Narrower than the Stage-10
  // finance.write_financial_config (reserved for finance_admin). SoD (maker != checker) is
  // enforced in the service ABOVE this permission.
  'finance.vat_facts',
  // SETTLE-1 (Track C PR 2): record/list payment receipts,
  // receivables aging, §5 eligibility evaluation, payout-identity
  // verification. Batch execution stays a future permission (SC
  // §31–§33 approval/execution separation).
  'finance.receipts',
  // Diagnostics / debug.
  'diagnostics.read',
  'diagnostics.run_seed',
  // Trust & safety.
  'report.read',
  'report.resolve',
  // Analytics.
  'analytics.read',
  // Closed-beta gate administration. Gates /admin/beta/* (create /
  // disable invite codes, manage allowlist, read redemption counts).
  // Granted to super_admin + operations_manager only.
  'beta.manage',
  // Corporate org review. Gates /admin/orgs/* (Corporate
  // Foundation PR 1 — list + approve/reject/request_changes on
  // Organization applications). Granted to super_admin +
  // operations_manager.
  'org.review',
  // Audit-trail read access. Gates GET /admin/audit-log (PR 11 —
  // the read-only viewer over AuditLog). Metadata rows can carry
  // old/new contact values for takeover forensics, so this is held
  // by super_admin + operations_manager + trust_safety only.
  'audit.read',
] as const satisfies readonly Permission[];

export type OpsPermission = (typeof OPS_PERMISSIONS)[number];

// Capability map. Role → permissions granted. super_admin is
// computed lazily at call time as "all permissions"; we don't
// enumerate them here to avoid drift when a new permission
// lands.
const PERMISSIONS_BY_ROLE: Record<
  Exclude<OpsRole, 'super_admin'>,
  OpsPermission[]
> = {
  operations_manager: [
    'store.review',
    'store.set_status',
    'store.set_featured',
    'store.read_detail',
    'user.read',
    'diagnostics.read',
    'diagnostics.run_seed',
    'report.read',
    'analytics.read',
    'beta.manage',
    'audit.read',
    'org.review',
  ],
  finance: [
    'finance.read_payouts',
    'finance.record_payout_event',
    'finance.approve_payout',
    'finance.reconcile',
    'finance.vat_facts',
    'finance.receipts',
    'store.read_detail',
    'analytics.read',
  ],
  merchant_review: ['store.review', 'store.read_detail', 'store.set_status'],
  support: [
    'store.read_detail',
    'user.read',
    'diagnostics.read',
    'report.read',
  ],
  trust_safety: [
    'user.read',
    'user.suspend',
    'user.restore',
    'report.read',
    'report.resolve',
    'store.set_status',
    'audit.read',
  ],
  fulfillment_ops: ['store.read_detail', 'diagnostics.read'],
  analytics_viewer: ['analytics.read'],
};

// Resolve a set of roles into the union of permissions they
// grant. `super_admin` short-circuits to "all permissions".
// Empty input → empty set.
export function permissionsFor(roles: readonly string[]): Set<OpsPermission> {
  const out = new Set<OpsPermission>();
  for (const raw of roles) {
    if (!isOpsRole(raw)) continue;
    if (raw === 'super_admin') {
      // Add every known permission. Hardcoding the seed list here
      // keeps super_admin honest as new permissions land — they
      // need to extend the OpsPermission union and SUPER_ADMIN_ALL
      // both. The TS compiler enforces the union extension; the
      // assertion below enforces the SUPER_ADMIN_ALL extension.
      for (const p of SUPER_ADMIN_ALL) out.add(p);
      continue;
    }
    for (const p of PERMISSIONS_BY_ROLE[raw]) out.add(p);
  }
  return out;
}

export function hasOpsPermission(
  roles: readonly string[],
  permission: OpsPermission,
): boolean {
  return permissionsFor(roles).has(permission);
}

// Authoritative permission list for super_admin. Update
// alongside OPS_PERMISSIONS — the typechecker enforces that
// every entry is a valid OpsPermission, but does NOT enforce
// that EVERY OpsPermission appears here. The ops-roles.spec.ts
// runtime test (PR B-3a) asserts the two are kept aligned so
// new permissions can't silently miss super_admin.
const SUPER_ADMIN_ALL: readonly OpsPermission[] = [
  'store.review',
  'store.set_plan',
  'store.set_featured',
  'store.set_status',
  'store.read_detail',
  'user.read',
  'user.set_role',
  'user.suspend',
  'user.restore',
  'user.purge',
  'user.assign_ops_role',
  'finance.read_payouts',
  'finance.record_payout_event',
  'finance.approve_payout',
  'finance.reconcile',
  'finance.vat_facts',
  'finance.receipts',
  'diagnostics.read',
  'diagnostics.run_seed',
  'report.read',
  'report.resolve',
  'analytics.read',
  'beta.manage',
  'audit.read',
  'org.review',
];
