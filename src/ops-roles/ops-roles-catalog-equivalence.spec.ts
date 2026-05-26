// Load-bearing equivalence proof for PR B-6a (OpsRoleGuard
// migration to the unified RBAC catalog).
//
// CONTRACT
// For every OpsRole × every OpsPermission, the legacy ops-roles.ts
// capability map and the unified RBAC catalog at src/rbac/role-map.ts
// must agree on the boolean outcome:
//
//     hasOpsPermission([role], perm) === permissionsForRoles([role]).has(perm)
//
// OpsRoleGuard dispatches between these two maps based on the
// RBAC_PERMISSION_CHECKS_ENABLED kill-switch. Behaviour preservation
// across the flag flip is true ONLY because the two maps agree on
// every (OpsRole, OpsPermission) pair the guard ever queries.
//
// COMPILE-TIME vs RUNTIME GUARANTEES
// B-3a `satisfies` clauses on OPS_ROLES + OPS_PERMISSIONS guarantee
// identifier-spelling alignment (no typos, no stale names). But
// content alignment — same set of permissions per role — is NOT
// enforced at compile time and is by design manually maintained on
// both sides. This spec is the only place where runtime content
// equivalence is asserted. CI failure here = production-risk drift.
//
// HOW TO RECOVER FROM A FAILURE HERE
// Do NOT skip or delete the test. Reconcile the two maps:
//   - If src/rbac/role-map.ts drifted, update it back to match
//     src/ops-roles/ops-roles.ts (the latter is the deployed
//     contract with OpsRoleAssignment rows).
//   - If src/ops-roles/ops-roles.ts drifted with intent, update
//     src/rbac/role-map.ts to match. Document the operational
//     reason in the PR description.
// A drift between the two maps means flipping
// RBAC_PERMISSION_CHECKS_ENABLED would change observable
// authorization for some real operator. Reconcile BEFORE merging
// the drift.
//
// IMPORTANT NOTE ON `admin.access`
// The catalog adds `admin.access` to every non-super_admin OpsRole's
// permission set. `admin.access` is NOT an OpsPermission (it lives
// outside OPS_PERMISSIONS). OpsRoleGuard never queries it. The
// equivalence assertion here is over the OPS_PERMISSIONS subset only,
// so this delta is benign by construction.

import { permissionsForRoles } from '../rbac/role-map';
import {
  OPS_PERMISSIONS,
  OPS_ROLES,
  hasOpsPermission,
  type OpsPermission,
  type OpsRole,
} from './ops-roles';

describe('ops-roles legacy vs catalog content equivalence (PR B-6a)', () => {
  // ─────────────────────────────────────────────────────────────────
  describe('every (OpsRole, OpsPermission) pair agrees across both maps', () => {
    // Parameterised over the full Cartesian product. With 8 ops roles
    // and 17 ops permissions, that is 136 assertions — every gate the
    // OpsRoleGuard could ever evaluate is covered.
    const cases: Array<{ role: OpsRole; permission: OpsPermission }> = [];
    for (const role of OPS_ROLES) {
      for (const permission of OPS_PERMISSIONS) {
        cases.push({ role, permission });
      }
    }

    it.each(cases)(
      'role=$role permission=$permission → legacy === catalog',
      ({ role, permission }) => {
        const legacy = hasOpsPermission([role], permission);
        const catalog = permissionsForRoles([role]).has(permission);
        expect(catalog).toBe(legacy);
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────
  describe('super_admin contract (catalog must dominate legacy)', () => {
    // Legacy super_admin via SUPER_ADMIN_ALL holds every OpsPermission.
    // Catalog super_admin via ALL_ADMIN_PERMISSIONS holds the broader
    // admin/finance/review/audit/flag union. For OpsRoleGuard purposes
    // the catalog set must be a superset of OPS_PERMISSIONS — i.e.,
    // no OpsPermission is silently missing from the catalog super_admin
    // entry. The parameterised block above already proves this per
    // (super_admin, perm) pair; this assertion is the explicit
    // intent-level statement readers expect to see.
    it('every OpsPermission is granted to super_admin by the catalog', () => {
      const catalogSuperAdminPerms = permissionsForRoles(['super_admin']);
      for (const perm of OPS_PERMISSIONS) {
        expect(catalogSuperAdminPerms.has(perm)).toBe(true);
      }
    });

    it('every OpsPermission is granted to super_admin by the legacy map', () => {
      for (const perm of OPS_PERMISSIONS) {
        expect(hasOpsPermission(['super_admin'], perm)).toBe(true);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('structural sanity (defence-in-depth on top of compile-time satisfies)', () => {
    it('OPS_ROLES has at least one role', () => {
      // Sanity check — a zero-length OPS_ROLES would make the
      // parameterised equivalence block above pass vacuously.
      expect(OPS_ROLES.length).toBeGreaterThan(0);
    });

    it('OPS_PERMISSIONS has at least one permission', () => {
      // Same reasoning — guards against vacuous equivalence.
      expect(OPS_PERMISSIONS.length).toBeGreaterThan(0);
    });

    it('OPS_ROLES contains exactly 8 documented role identifiers', () => {
      // Pinned as a freeze-point: adding a 9th OpsRole means the
      // catalog also needs a new ROLE_PERMISSIONS entry, plus a
      // matching PERMISSIONS_BY_ROLE entry in ops-roles.ts. This
      // assertion fails fast on either-side drift to remind the
      // author to update both maps.
      expect(OPS_ROLES.length).toBe(8);
    });

    it('OPS_PERMISSIONS contains exactly 19 documented permission identifiers', () => {
      // Same freeze-point reasoning as above. Adding a new
      // OpsPermission requires updating both ops-roles.ts
      // (PERMISSIONS_BY_ROLE + SUPER_ADMIN_ALL) and role-map.ts
      // (ROLE_PERMISSIONS entries for every relevant role).
      //
      // Count history:
      //   17 — original Week-2 catalog (PR B-3).
      //   18 — `user.restore` added with the disable/restore endpoints
      //        (backend/identity-and-admin-controls commit C2).
      //   19 — `user.purge` added with the permanent-deletion
      //        endpoint (this PR). Granted ONLY to super_admin.
      expect(OPS_PERMISSIONS.length).toBe(19);
    });
  });
});
