// Closed-beta sandbox simulation — single source of truth.
//
// The platform is entering closed beta. Real payment provider
// integration has not landed yet; every order today runs through
// the mock-gateway path (`POST /payments/mock/confirm`). Until real
// PSPs are wired, every Order / Gift / PayoutEvent produced by the
// platform is functionally sandbox. We need an explicit, durable
// marker on each row so:
//
//   1. Admin + merchant surfaces can distinguish "test gift that
//      walked the full lifecycle" from "real gift that captured
//      money" — once real PSPs come online the same DB will hold
//      both.
//   2. Finance / payout balances exclude sandbox rows by default
//      so closed-beta test activity can never settle to a real
//      merchant ledger.
//   3. The future real-PSP entry point has an authoritative gate
//      to refuse capture against sandbox orders ("can't real-pay
//      a test order"), and the mock-PSP gate can refuse live
//      orders post-beta ("can't mock-pay a live order").
//
// The flag lives on three rows (Order, Gift, PayoutEvent). The
// boundary check is per-row, not env-based at runtime — env state
// determines what NEW rows are tagged with, but once written the
// row is the source of truth forever.
//
// ─────────────────────────────────────────────────────────────────────
// Closed-beta enforcement model
// ─────────────────────────────────────────────────────────────────────
//
// Two layers, in this order:
//
//   1. SANDBOX_ONLY_MODE env flag (deployment-level).
//      - true  → every NEW Order/Gift created in this deploy is
//                forced isSandbox=true, regardless of request body.
//      - false → request body controls the flag (default false).
//      - missing/unset/anything else → treated as false. The safer
//                production-default. Production can NEVER become
//                sandbox by accident; you must explicitly set the
//                env var.
//
//   2. Per-row isSandbox column (write-time).
//      Set at create time using resolveSandboxFlag(). Once written,
//      the row's flag is immutable for downstream lifecycle
//      decisions — payments, payouts, admin filtering all consult
//      the row, never the live env state.
//
// Why both layers? The env flag prevents a frontend bug or a
// missing-flag in the checkout body from creating a real Order
// during closed beta. The per-row flag prevents the env flipping
// post-beta from retroactively reclassifying already-created test
// rows as live. The two together make the system safe to operate
// even as the deployment transitions from "sandbox-only" to "mixed
// sandbox + live" to "live-only."
//
// Pure module. No Prisma, no Nest, no DI. Tested in isolation.

// True iff the deploy is in "force all new orders sandbox" mode.
// Reads the env var on every call (not cached) so test code can
// flip it mid-suite via `process.env.SANDBOX_ONLY_MODE = '...'`.
// In production the env var doesn't change between requests; the
// per-call read is essentially free.
//
// The strict `=== 'true'` check is deliberate. Any other value —
// undefined, '1', 'yes', 'TRUE', '' — is treated as false. This
// makes "the env var is set to a non-boolean string" fail safe to
// live-mode (the production-correct default) instead of
// fail-open to sandbox.
export function isSandboxOnlyModeEnabled(): boolean {
  return process.env.SANDBOX_ONLY_MODE === 'true';
}

// Resolve the isSandbox flag to write on a new Order or direct
// Gift. The caller passes the request-supplied value (may be
// undefined / false / true); this helper folds in the deployment-
// level env flag and returns the final value.
//
// Decision matrix:
//
//   SANDBOX_ONLY_MODE  requested  → resolved
//   ─────────────────  ─────────    ────────
//   true               anything   → true   (env forces sandbox)
//   false              undefined  → false  (production default)
//   false              false      → false  (explicit live)
//   false              true       → true   (explicit sandbox)
//
// During closed beta we set SANDBOX_ONLY_MODE=true in Railway, so
// every checkout produces sandbox orders regardless of what the
// frontend sends. Post-beta, the flag is flipped off and the body
// controls per-request — useful for staging tests in a live deploy.
export function resolveSandboxFlag(
  requestedSandbox: boolean | undefined,
): boolean {
  if (isSandboxOnlyModeEnabled()) return true;
  return requestedSandbox === true;
}
