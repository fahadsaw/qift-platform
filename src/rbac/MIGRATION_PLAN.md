# apps/api RBAC Guard Migration — Backend Plan

This document is the backend counterpart to `lib/rbac/CATALOG_REVIEW.md`
in the frontend repo (`qift-ui-v2`). It captures the verified backend
reality (from PR B-0a inspection) and the migration plan as adjusted
after that verification.

**Status as of PR B-1**: catalog ported, tests landing, no guard
migrated, no flag plumbed.

---

## 1. Verified backend reality

| Item | Verified value |
|---|---|
| Framework | NestJS 11 (`@nestjs/common@^11.0.1`, `@nestjs/core@^11.0.1`) |
| ORM | Prisma `^5.22.0` |
| Auth | `passport-jwt@^4.0.1` via `@nestjs/passport@^11.0.5` + `@nestjs/jwt@^11.0.2` |
| Test framework | Jest + `@nestjs/testing` |
| Env-var pattern | **Raw `process.env`**. No `@nestjs/config`. No `ConfigService`. |
| Existing boolean-flag precedent | `process.env.QIFT_GIFT_SESSION_HTTP_ENABLED === 'true'` (single-form) |
| `User.role` enum | exactly `"user" \| "store" \| "admin"` per `prisma/schema.prisma` |
| Guard locations | See § 2 |
| Permission decorator | `@RequireOpsPermission(permission: OpsPermission)` — **singular**, defined in `ops-role.guard.ts` |
| Audit infrastructure | **Partly in place** — `src/audit/`, `audit.service.spec.ts`, `test/audit-log.e2e-spec.ts` already exist |
| Repo layout | Separate from frontend (`~/Dev/qift-platform/` ≠ `~/Dev/qift-ui-v2/`) |

## 2. Guard inventory

| Guard | Path | Type |
|---|---|---|
| `JwtAuthGuard` | `src/auth/jwt.guard.ts` | Thin `AuthGuard('jwt')` wrapper |
| `OptionalJwtGuard` | `src/auth/optional-jwt.guard.ts` | Public-with-attribution |
| `AdminGuard` | `src/admin/admin.guard.ts` | **DB-backed role check** — re-loads `User.role` per request, rejects on `deletedAt` |
| `StoreGuard` | `src/store/store.guard.ts` | **OWNERSHIP check** (calls `StoresService.ownedStoreIds`), NOT a role check; has `STORE_USER_IDS` env-var allow-list bypass |
| `OpsRoleGuard` | `src/ops-roles/ops-role.guard.ts` | Permission-decorator reader; delegates to `OpsRolesService.userHasPermission` |

No global `APP_GUARD` provider. Guards are bound per-controller via
`@UseGuards(JwtAuthGuard, AdminGuard, OpsRoleGuard)`.

---

## 3. Plan adjustments (from PR B-0a verification)

### Adjustment A — PR B-7 (StoreGuard role migration): **DROPPED**

**Reason**: `StoreGuard` is an ownership check, not a role check.
There is no `user.role === 'store'` enforcement to migrate on the
backend. Ownership-based gating is correct as-is and remains
**unchanged**.

The frontend's PR 6 (`canViewMerchantFinance`) consumed the catalog's
`merchant_finance.read_own` permission as a CLIENT-SIDE UX gate. That
client-side gate is preserved. Server-side, the merchant dashboard
remains owned by the ownership-based `StoreGuard`.

### Adjustment B — PR B-0b (CI drift check): **REVISED for separate-repo reality**

**Reason**: `qift-platform/` and `qift-ui-v2/` are independent git
repositories with no shared workspace.

**Revised approach**: vendored snapshot + drift check.
- Each backend PR that touches `src/rbac/` includes (or implies an
  update to) a vendored snapshot of the frontend `lib/rbac/`
  identifiers at `apps/api/scripts/rbac-frontend-snapshot.json` (or
  similar — exact format TBD in PR B-0b).
- A CI script (`apps/api/scripts/check-rbac-drift.ts`) compares the
  backend catalog against the snapshot and exits non-zero on any
  diff.
- The snapshot is updated by hand when the frontend catalog changes;
  the backend PR that mirrors a frontend change carries the snapshot
  update.

**Shared-package promotion** is deferred until both catalogs are
stable. After ≥4 weeks of clean drift checks, extracting to a shared
npm package (or git submodule) is appropriate. **Not in PR B-0b
scope.**

### Adjustment C — PR B-4 (first guard migration): **REVISED for AdminGuard reality**

`AdminGuard` does THREE things, not one:
1. Loads the `User` row from the DB (does NOT trust JWT payload).
2. Rejects soft-deleted users (`deletedAt != null`).
3. Checks `user.role === 'admin'`.

**Only step 3 is migrated.** Steps 1 and 2 remain outside the RBAC
dispatch and must be preserved exactly.

**Migration shape**:
```
async canActivate(ctx) {
  const userId = req.user?.userId
  if (!userId) throw new ForbiddenException('Admin access required')

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, deletedAt: true },
  })
  if (!user || user.deletedAt) {
    throw new ForbiddenException('Admin access required')
  }

  // — Dual-path RBAC dispatch lives here —
  if (arePermissionChecksEnabled()) {
    if (!hasPermission(user, 'admin.access')) {
      throw new ForbiddenException('Admin access required')
    }
  } else {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Admin access required')
    }
  }
  return true
}
```

The exception message stays exactly `'Admin access required'` in
every branch — operators / clients see no difference.

**First migrated endpoint**: `GET /admin/system`
(`admin.controller.ts:175`, `@Get('system')` inside `@Controller('admin')`).
This endpoint has `@UseGuards(JwtAuthGuard, AdminGuard, OpsRoleGuard)`
at controller level and **no** `@RequireOpsPermission` decorator, so
only `AdminGuard`'s role check actually gates it. Ideal first
migration — zero coordination with `OpsRoleGuard` required.

**First test file**: `src/admin/admin.guard.spec.ts` — created NEW
in PR B-4 (no guard tests exist anywhere in the backend today).

---

## 4. Documented notes (from PR B-0a)

1. **`@RequireOpsPermission` is singular**, not array. Decorator takes
   one `OpsPermission`; the guard's metadata-reader uses
   `reflector.getAllAndOverride<OpsPermission | undefined>`.

2. **Raw `process.env` convention**. No `@nestjs/config`, no
   `ConfigService`. The kill-switch helper (PR B-3) reads
   `process.env.RBAC_PERMISSION_CHECKS_ENABLED` directly.

3. **Flag accepts both `'true'` and `'1'`**. Existing backend
   precedent (`QIFT_GIFT_SESSION_HTTP_ENABLED`) uses `'true'` only;
   the new kill-switch helper accepts both for cross-repo symmetry
   with the frontend's `arePermissionChecksEnabled()`. JSDoc on the
   helper notes that operators following backend precedent will use
   `'true'`.

4. **`apps/api` already has partial audit infrastructure**.
   `src/audit/`, `audit.service.spec.ts`, `test/audit-log.e2e-spec.ts`,
   `AUDIT_LOGGING.md` (in `qift-platform/` root) all exist. Stage 10
   audit-log work (Stage 10.0 # 3) has a head start. Worth a
   dedicated inspection PR before that workstream begins, but **not
   in scope for the RBAC migration**.

5. **`StoreGuard` is deferred, not migrated**. Ownership-based gating
   is preserved. Adjustment A above.

---

## 5. PR sequence (adjusted)

```
Pre-flight
├── PR B-0a  — backend verification report (DONE)
└── PR B-0b  — CI drift check via vendored snapshot (revised; pending)

Catalog parity
├── PR B-1   — port catalog + unit tests (THIS PR)
├── PR B-2   — port hasPermission helper + unit tests
└── PR B-3   — port permission-checks-flag helper + unit tests

Catalog alignment
└── PR B-3a  — refactor src/ops-roles/ops-roles.ts to satisfy
                readonly Permission[] from src/rbac/permissions.ts;
                preserves runtime behavior of OpsRolesService

First guard migration
└── PR B-4   — migrate AdminGuard for GET /admin/system behind
                kill-switch (creates src/admin/admin.guard.spec.ts);
                verify staging soak ≥1 week with
                RBAC_PERMISSION_CHECKS_ENABLED=1

Soak + extend
├── PR B-5   — migrate remaining /admin/* GET endpoints
├── PR B-6   — migrate /admin/* mutation endpoints (one per PR for
                sensitive ones; coordinate with OpsRoleGuard which
                still consults legacy OpsPermission until B-6a)
└── PR B-6a  — switch OpsRoleGuard to consult new catalog when flag ON

— PR B-7 dropped: StoreGuard ownership-only, no role to migrate. —

— Out of scope (future Stage 10.0 work) —
PR B-8  — promote vendored snapshot to shared package
PR B-9  — UserRoleAssignment table + backfill
PR B-10 — flip RBAC_PERMISSION_CHECKS_ENABLED ON in production
PR B-11 — narrow legacy_admin to W1 roles; assign finance_admin
          explicitly per-operator
```

---

## 6. Hard limits (carried forward from main plan)

- No financial logic (no payouts, reserves, ledger writes, PSP, BNPL,
  ZATCA, real money movement)
- No DB schema changes
- No new endpoints (every migrated endpoint keeps its route, method,
  request shape, response shape, status codes, exception types)
- No new env-var dependencies beyond `RBAC_PERMISSION_CHECKS_ENABLED`
- No new permissions added to the catalog beyond the 62 ported from
  the frontend
- No removal of existing guards
- Production kill-switch stays OFF — migration PRs do not enable in
  prod
- `flag.write_financial` stays inert until the feature-flag registry
  actually lands

---

## 7. References

- Frontend catalog: `qift-ui-v2/lib/rbac/`
- Frontend catalog review (audit, findings, migration history):
  `qift-ui-v2/lib/rbac/CATALOG_REVIEW.md`
- This module's catalog: `apps/api/src/rbac/`
- AdminGuard: `apps/api/src/admin/admin.guard.ts`
- StoreGuard: `apps/api/src/store/store.guard.ts` (ownership-based;
  not migrated)
- OpsRoleGuard + decorator + legacy catalog:
  `apps/api/src/ops-roles/`
- Existing audit module: `apps/api/src/audit/`
- Existing risk-signal module: `apps/api/src/risk-signals/`
- FRP v1.1 § 9.6.3 — merchant access matrix
- Stage 10 § 19 — W1 RBAC architecture
