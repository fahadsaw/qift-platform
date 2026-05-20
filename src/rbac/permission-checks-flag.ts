// Kill-switch flag for the RBAC permission-check migration (backend
// mirror of qift-ui-v2/lib/rbac/permissionChecksFlag.ts).
//
// PURPOSE
// Future PRs (PR B-4 onward) will migrate backend guards from the
// legacy `user.role === 'admin'` check to `hasPermission(user, perm)`
// from has-permission.ts. Each migrated guard will read
// `arePermissionChecksEnabled()` at request time and:
//   - when true  → route through the new permission check
//   - when false → fall back to the legacy role check (current
//                  behaviour)
//
// This dual-path approach lets us migrate guards one at a time,
// verify behaviour in dev / staging, and flip back to the legacy
// path instantly if anything drifts. The new code path stays in
// place even when the flag is OFF, so re-enabling does not require
// a follow-up deploy — only an env-var flip and a restart.
//
// PR B-3 ONLY ADDS THIS HELPER.
// No guard reads from it yet. Importing this module has no side
// effects. The first guard migration lands in PR B-4 (AdminGuard for
// GET /admin/system).
//
// FLAG IDENTIFIER
// Conceptual flag name: `rbac.permission_checks_enabled` (this is
// the entry that will appear in the future feature-flag registry
// when it lands).
// Environment override: `RBAC_PERMISSION_CHECKS_ENABLED`.
//   Truthy: '1' or 'true'
//   Falsy:  '0' or 'false'
// Any other value (including unset) falls back to the NODE_ENV
// default below.
//
// Backend boolean-flag precedent (e.g.
// `QIFT_GIFT_SESSION_HTTP_ENABLED === 'true'`) uses `'true'` only.
// This helper accepts BOTH `'1'` and `'true'` to stay symmetric with
// the frontend helper at qift-ui-v2/lib/rbac/permissionChecksFlag.ts.
// Operators following backend precedent should use `'true'`; either
// works.
//
// DEFAULTS
//   development → ON  (dev / local exercise the new path automatically)
//   test        → ON  (so any unit / e2e test runs hit the new path
//                      where the flag would matter)
//   production  → OFF (safe — guards keep the legacy check until
//                      the operator explicitly opts in)
//   anything else / undefined → OFF (conservative)
//
// STAGING DETECTION
// NestJS sets NODE_ENV to 'production' in staging deployments by
// default. The codebase has no established deploy-environment env
// var convention today. Staging builds therefore default to OFF
// unless the operator sets `RBAC_PERMISSION_CHECKS_ENABLED=true`
// (or `=1`) explicitly on the staging environment. When a deploy-
// env convention is established in the future, extend this helper
// to default ON for the staging signal.
//
// SERVER-SIDE ONLY
// This is a server-side helper. The frontend has its own mirror
// helper that reads the same env var name; the two are independent.
// On the frontend, the same value will require a build-time
// mechanism (NEXT_PUBLIC_*) for client-visible exposure — but the
// frontend client-side flag handling is documented there.

export function arePermissionChecksEnabled(): boolean {
  const explicit = process.env.RBAC_PERMISSION_CHECKS_ENABLED;
  if (explicit === '1' || explicit === 'true') return true;
  if (explicit === '0' || explicit === 'false') return false;

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'development' || nodeEnv === 'test') return true;

  return false;
}
