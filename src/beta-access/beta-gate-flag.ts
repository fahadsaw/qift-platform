// Master switch for the Closed Beta Gate.
//
// PURPOSE
// When ON, /auth/register admits a new account only if it clears the
// gate (allowlist match OR a valid invite code). When OFF, registration
// is fully open and NONE of the Beta* tables are consulted.
//
// DEFAULT IS OFF — EVERYWHERE.
// Unlike the RBAC permission-checks flag (which defaults ON in
// dev/test), the beta gate defaults OFF in every environment including
// development and test. Rationale:
//   - The gate is a product-launch decision, not a code-correctness
//     migration. Defaulting it ON in dev would force every local
//     signup + every existing auth test to carry an invite code.
//   - Existing /auth/register unit + e2e tests assert the open-
//     registration behaviour; they must keep passing untouched. A
//     dedicated beta-gate spec flips the env var ON explicitly.
//
// ENABLING IN PRODUCTION
// Set `BETA_GATE_ENABLED=true` (or `=1`) on the production environment
// and restart. Flip back to `false` / unset to reopen registration
// instantly — no redeploy, the gate code stays in place.
//
// Accepts BOTH '1' and 'true' to stay symmetric with the other backend
// boolean flags (RBAC_PERMISSION_CHECKS_ENABLED) and the frontend
// mirrors. Any other value (including unset) → OFF.

export function isBetaGateEnabled(): boolean {
  const v = process.env.BETA_GATE_ENABLED;
  return v === '1' || v === 'true';
}
