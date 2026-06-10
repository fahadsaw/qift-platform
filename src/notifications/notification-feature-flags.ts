// Phase 7.1 + 7.2 — notification feature flags.
//
// Centralised env-var-driven flags so the rest of the codebase
// can ask "is this delivery surface enabled?" without scattering
// `process.env.FOO === 'true'` checks. Pure module — no Nest, no
// DI. Read at the call site at request time so changes to the
// env take effect on the next request without a deploy.
//
// FLAG TAXONOMY
//
//   Activation flags (boolean) — does the worker / channel
//   exist and operate at all?
//     QIFT_OCCASION_REMINDER_FIRING_ENABLED
//     QIFT_DIGEST_WORKER_ENABLED
//     QIFT_PUSH_DELIVERY_ENABLED
//     QIFT_EMAIL_DELIVERY_ENABLED
//     QIFT_SMS_DELIVERY_ENABLED
//
//   Rollout shape (controlled activation) — among the workers
//   that ARE enabled, which users does delivery actually reach?
//     QIFT_REMINDER_DRY_RUN
//       When true, the worker runs through every step and LOGS
//       what would have been sent, but skips the orchestrator
//       call. Lets us validate candidate selection + idempotency
//       claims in production without paging real users.
//     QIFT_REMINDER_ALLOWLIST
//       Comma-separated user-id list. When non-empty, ONLY these
//       users have their reminders processed. Used for internal-
//       account-only canary rollout. Empty = no allowlist gate
//       (all users eligible — subject to sample-percent below).
//     QIFT_REMINDER_USER_SAMPLE_PERCENT
//       Integer 0..100. After the allowlist, this percent of
//       candidate users have their reminders processed; the rest
//       are skipped (and NOT recorded as fired, so a later
//       percent bump picks them up). Default 100 (everyone).
//
// SAFETY DEFAULTS
// Every activation flag defaults OFF; rollout shape defaults to
// the most-restrictive (dry-run off, no allowlist, 100% sample).
// The intersection: when all activation flags are off (the Phase
// 7.1 + 7.1B default), nothing fires regardless of rollout shape.
//
// Why env-var gates rather than database flags:
//   - Env changes are fast + atomic + rollback-able.
//   - No accidental cross-environment activation (staging vs prod
//     each have their own .env).
//   - No DB round-trip per request to check the flag.
//
// Activation order recommendation (Phase 7.2 rollout):
//   1. Set QIFT_REMINDER_DRY_RUN=true + run worker manually via
//      admin endpoint. Verify candidate selection in logs.
//   2. Set QIFT_REMINDER_ALLOWLIST=<your-own-userId> + drop
//      QIFT_REMINDER_DRY_RUN. You receive real reminders;
//      everyone else still skipped.
//   3. Expand allowlist to internal team. Verify cadence + copy.
//   4. Remove allowlist + set QIFT_REMINDER_USER_SAMPLE_PERCENT=10.
//      10% of users start receiving reminders.
//   5. Gradually raise to 100. Each step monitored via the
//      ReminderFiring audit table + suppression telemetry.
//
// Every step is reversible by editing the env. The
// ReminderFiring table preserves history regardless.

function read(name: string): boolean {
  const raw = process.env[name];
  return raw === 'true';
}

function readString(name: string): string {
  return (process.env[name] ?? '').trim();
}

function readPercent(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return 100;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 100;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

// ── Activation flags ───────────────────────────────────────────

export function isOccasionReminderFiringEnabled(): boolean {
  return read('QIFT_OCCASION_REMINDER_FIRING_ENABLED');
}

export function isDigestWorkerEnabled(): boolean {
  return read('QIFT_DIGEST_WORKER_ENABLED');
}

// Occasions Activation — the in-process scheduler that ticks the
// reminder + digest workers on an interval (the "future scheduler"
// the worker docs anticipated). Default OFF like every other
// activation flag: deploying the scheduler changes nothing until
// the operator opts in, and even then each worker's own activation
// flag still gates real work — double-gated by design.
export function isWorkerSchedulerEnabled(): boolean {
  return read('QIFT_NOTIFICATION_SCHEDULER_ENABLED');
}

// Global push kill switch. EMERGENCY-STOP semantics: defaults to
// ENABLED (preserving the existing push-fanout behaviour that has
// been live since the gift-flow shipped). Set explicitly to
// 'false' to disable — when off, the orchestrator's push fanout
// is suppressed regardless of category eligibility or per-user
// preferences; the in-app Notification row still writes (the
// always-on inbox) but no push fires.
//
// Unique inversion: this flag is the ONLY notification flag that
// reads "false = off, anything else = on" rather than the
// "default-deny / explicit-true to enable" pattern of the rest.
// Reason: every other flag gates a NEW capability (Phase 7.2
// reminder firing, future SMS / email). Push has been live all
// along — defaulting it off would regress the gift-flow
// notifications that already worked.
export function isPushDeliveryEnabled(): boolean {
  // Explicit 'false' disables. Anything else (unset, 'true', '1',
  // 'yes') keeps push enabled — same default-permissive posture
  // the existing PushService had before this flag was introduced.
  return process.env.QIFT_PUSH_DELIVERY_ENABLED !== 'false';
}

// Email channel kill switch. Off in Phase 7.2 — no email adapter
// yet (per project_external_integrations_architecture.md the
// adapter lands once SendGrid / SES contracts complete).
export function isEmailDeliveryEnabled(): boolean {
  return read('QIFT_EMAIL_DELIVERY_ENABLED');
}

// SMS channel kill switch. Off in Phase 7.2 — no SMS adapter
// yet. OTP continues to use the existing OtpService path, which
// is a separate (already-implemented) surface and does NOT run
// through this flag.
export function isSmsDeliveryEnabled(): boolean {
  return read('QIFT_SMS_DELIVERY_ENABLED');
}

// ── Rollout shape ──────────────────────────────────────────────

export function isReminderDryRun(): boolean {
  return read('QIFT_REMINDER_DRY_RUN');
}

// Parse the comma-separated allowlist. Empty list = no allowlist
// gate (i.e. all users eligible, subject to sample-percent).
// Whitespace + empty entries are tolerated.
export function reminderAllowlist(): readonly string[] {
  const raw = readString('QIFT_REMINDER_ALLOWLIST');
  if (raw.length === 0) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function reminderUserSamplePercent(): number {
  return readPercent('QIFT_REMINDER_USER_SAMPLE_PERCENT');
}

// ── Composite gates ────────────────────────────────────────────

// Stable hash-based sampling: same userId always falls into the
// same percentile bucket across worker runs. A user at percent
// 7 stays at 7 forever — gradual rollout doesn't flip them in
// and out of eligibility.
//
// `userId` strings are hashed via a small FNV-1a variant + mapped
// to 0..99. The function is deterministic + cheap + collision-
// rate is irrelevant (we want uniform distribution, not unique
// hashing).
function userPercentile(userId: string): number {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i += 1) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // h is a signed 32-bit int. Take abs + mod 100.
  return Math.abs(h) % 100;
}

// Should this specific user be processed in this worker run?
// Combines the allowlist + sample-percent gates. The activation
// flag is checked separately (one-shot at the top of the worker).
export function shouldProcessUserForReminders(userId: string): boolean {
  return reminderProcessDecision(userId).kind === 'process';
}

// Telemetry-friendly variant. Returns the same accept/reject
// decision as shouldProcessUserForReminders, but distinguishes
// allowlist-rejection from sample-percent-rejection so the worker
// can keep honest counters per rollout gate. Callers that just
// need the boolean keep using shouldProcessUserForReminders.
export type ReminderProcessDecision =
  | { kind: 'process' }
  | { kind: 'reject_allowlist' }
  | { kind: 'reject_sample_percent' };

export function reminderProcessDecision(
  userId: string,
): ReminderProcessDecision {
  const allow = reminderAllowlist();
  if (allow.length > 0) {
    // Allowlist mode: only listed users; sample-percent ignored.
    return allow.includes(userId)
      ? { kind: 'process' }
      : { kind: 'reject_allowlist' };
  }
  // No allowlist → sample-percent applies. 100% = everyone (the
  // default); 0% = no one; 10% = stable 10% bucket.
  const pct = reminderUserSamplePercent();
  if (pct >= 100) return { kind: 'process' };
  if (pct <= 0) return { kind: 'reject_sample_percent' };
  return userPercentile(userId) < pct
    ? { kind: 'process' }
    : { kind: 'reject_sample_percent' };
}
