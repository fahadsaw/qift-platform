// Phase 7.1 — notification feature flags.
//
// Centralised env-var-driven flags so the rest of the codebase
// can ask "is this delivery surface enabled?" without scattering
// `process.env.FOO === 'true'` checks. Pure module — no Nest, no
// DI. Read at the call site at request time so changes to the
// env take effect on the next request without a deploy.
//
// IMPORTANT — what these flags do:
//
//   QIFT_OCCASION_REMINDER_FIRING_ENABLED
//     The future occasion-reminder worker reads this. When false
//     (the Phase 7.1 default), NO reminders fire — even though
//     the data layer + orchestrator route would handle them
//     cleanly. The flag exists so we can validate the budget /
//     quiet-hours / opt-out infrastructure in production with
//     real traffic BEFORE turning on the actual reminder volume.
//     Activation is a one-line env change; the system is built
//     to accept the load.
//
//   QIFT_DIGEST_WORKER_ENABLED
//     The future digest batch worker reads this. When false (the
//     Phase 7.1 default), notifications queued for digest
//     (pushDeliveredAt: null) sit in the table indefinitely. The
//     in-app inbox still shows them; the alert channels (push /
//     email / SMS) just never fire the deferred batch. Once the
//     worker lands in Phase 7.2, flipping this to true activates
//     batched delivery.
//
// Why env-var gates rather than database flags:
//   - Env changes are fast + atomic + rollback-able.
//   - No accidental cross-environment activation (staging vs prod
//     each have their own .env).
//   - No DB round-trip per request to check the flag.
//
// Test-mode override: tests can pass an explicit value to the
// internal `read()` helper so spec files don't depend on the
// real env. The public surface accepts the env name only.

function read(name: string): boolean {
  const raw = process.env[name];
  // Default-deny: anything other than the literal 'true' string
  // counts as off. This avoids accidentally enabling delivery
  // when someone sets the var to '1' / 'yes' / 'enabled'
  // expecting it to be truthy — only the explicit 'true' arms it.
  return raw === 'true';
}

// Reminder firing — the most user-visible flag. The data layer
// (Phase 6 occasion reminders) is fully built and the orchestrator
// would handle the delivery decision correctly. This flag holds
// the door closed until we're ready to observe real reminder
// volume.
export function isOccasionReminderFiringEnabled(): boolean {
  return read('QIFT_OCCASION_REMINDER_FIRING_ENABLED');
}

// Digest batch worker — fires the queued (pushDeliveredAt-null)
// notifications on the per-user digest cadence. Off in Phase 7.1
// because the worker itself hasn't been written; the schema +
// orchestrator are ready when it lands.
export function isDigestWorkerEnabled(): boolean {
  return read('QIFT_DIGEST_WORKER_ENABLED');
}
