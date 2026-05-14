# Phase 7 Canary Runbook — Internal Controlled Activation

This file is the **operator reference** for the Phase 7 internal
canary. It is NOT a public-rollout doc, NOT a marketing plan, and
NOT a product spec. It is the day-by-day runbook for safely
turning on the reminder + digest workers against real internal
accounts before any broader activation.

If you are reading this with the goal of "turn things on for
everyone", you are reading the wrong document. Stop here and read
[notification channels policy](../../../.claude/projects/-Users-fahadaldossari-Dev-qift-ui-v2/memory/project_notification_channels_policy.md)
first.

---

## 0. Scope

**In scope**:
- OccasionReminderWorker (Phase 7.2) firing real reminders to internal users.
- DigestWorker (Phase 7.2) batching queued rows into calm summaries.
- NotificationOrchestrator (Phase 7.1) routing + budgets + quiet hours.
- Existing web push fanout (already live since gift flow shipped).
- Operator observability via `GET /admin/workers/status`.

**Out of scope**:
- Cron / scheduled activation. The worker is triggered manually
  via admin endpoints throughout the canary. A cron lands only
  after the canary completes.
- SMS / email channels. No provider adapters in this phase.
- Public rollout. The allowlist + sample-percent gates stay
  engaged throughout.
- Growth notifications, marketing pushes, recommendation
  notifications. Out of scope architecturally per Section 17 of
  the canonical architecture doc.

---

## 1. Pre-canary state (start here)

Before flipping anything on, confirm the current state. Hit:

```
GET /admin/workers/status
Authorization: Bearer <admin-jwt>
```

Expected response shape (all default-OFF):

```json
{
  "asOf": "<iso>",
  "flags": {
    "occasionReminderFiringEnabled": false,
    "digestWorkerEnabled":           false,
    "pushDeliveryEnabled":           true,
    "emailDeliveryEnabled":          false,
    "smsDeliveryEnabled":            false,
    "reminderDryRun":                false,
    "reminderAllowlist":             [],
    "reminderUserSamplePercent":     100
  },
  "queue": {
    "staleClaims":    0,
    "pendingDigest":  0
  },
  "last24h": {
    "firingsByStatus": {}
  },
  "mostRecentFiring": null
}
```

If any flag in the first three lines (`occasionReminderFiringEnabled`,
`digestWorkerEnabled`, `pushDeliveryEnabled`) doesn't match the
above, STOP. Reconcile with the env before proceeding.

`pushDeliveryEnabled` defaults TRUE intentionally — push has been
live since the gift flow shipped. Disabling it would regress
already-working notifications. It's the global kill-switch (set
env to `'false'` if needed).

---

## 2. Stage-by-stage activation order

Each stage has: env state, expected observation, success/failure
signals, and how long to stay in it. Don't skip a stage.

### Stage 0 — Pre-flight (1 day)

**Env**: all defaults (everything off).

**Action**: deploy the canary code. Hit `/admin/workers/status` to
confirm the snapshot returns the all-OFF state above. Tail logs
for `Phase 7` mentions (should be silent — no worker activity).

**Success**: snapshot matches expected; no worker activity in logs.

**Failure**: snapshot shows wrong flag state OR there's worker
activity → stop and investigate before proceeding.

### Stage 1 — Reminder dry-run (2–3 days)

**Env additions**:

```
QIFT_REMINDER_DRY_RUN=true
```

(Activation flag still OFF. Dry-run is the escape hatch — the
worker runs the candidate selection + firing-window math but
writes NOTHING and calls NO orchestrator.)

**Action**: invoke the worker manually once per day:

```
POST /admin/workers/run-reminders
Authorization: Bearer <admin-jwt>
```

Response includes `filteredDryRun=<N>` confirming the worker saw
candidates but did nothing. Log line includes a `DRY-RUN would
fire reminderId=... userId=...` entry for every candidate.

**Observe**:
- Are the candidates the expected internal users?
- Does the firing-day math match your manual calculation?
  (`occurrenceAt = nextOccurrence(occasion, now)`,
   `firingDay = occurrenceAt - daysBefore`)
- Are there any unexpected user ids surfacing?

**Success**:
- `ran: true`, `filteredDryRun > 0` for at least one trigger.
- All `DRY-RUN would fire` log lines reference internal user ids
  you recognise.
- No `errors`.

**Failure**:
- Unexpected user ids → STOP. The allowlist isn't engaged yet;
  the worker is seeing every reminder. Check that real users
  haven't set up occasions yet, OR set the allowlist before
  proceeding.
- Errors > 0 → investigate before proceeding.

**DO NOT proceed to Stage 2 until you've seen at least one
dry-run cycle that exercised a real T-7 or T-1 firing day on an
internal account.**

### Stage 2 — Self-only allowlist (2 days)

**Env additions** (still drop dry-run for THIS user; allowlist
keeps it scoped):

```
QIFT_REMINDER_DRY_RUN=        (cleared / unset)
QIFT_OCCASION_REMINDER_FIRING_ENABLED=true
QIFT_REMINDER_ALLOWLIST=<your-own-userId>
```

**Action**: manually trigger:

```
POST /admin/workers/run-reminders
```

This is the first stage that actually FIRES real notifications.
Only your own userId is processed; all other candidates get
`filteredAllowlist += 1`.

**Observe**:
- The reminder lands on your own device with the calm copy
  ("A moment coming up — <label> — <timing phrase>").
- The deep link goes to `/occasions` (not `/notifications`).
- The push body matches the in-app body.
- `mostRecentFiring.firedAt` updates in the snapshot.
- A `ReminderFiring` row exists in `status='sent'`.

**Success**:
- Reminder arrived, deep-link works, body is calm + generic.
- Snapshot shows `firingsByStatus.sent = 1`.
- No stale claims (`queue.staleClaims = 0`).

**Failure**:
- Reminder didn't arrive: check `pushDeliveredAt` on the new
  Notification row; check VAPID config; check push subscription
  existed.
- Deep link rewrote to `/notifications`: that's the symptom of
  the push allow-list missing `/occasions`. The fix is already
  in `push.service.ts:SAFE_URL_PREFIXES`. If you see this,
  STOP — something's regressed.
- `staleClaims > 0` after the run: investigate the failed
  firings before proceeding. Run cleanup if needed (Section 5).

### Stage 3 — Internal team allowlist (5–7 days)

**Env additions**:

```
QIFT_REMINDER_ALLOWLIST=<your-userId>,<teammate-1>,<teammate-2>,...
```

**Action**: same daily manual trigger.

**Observe**:
- Multiple human eyes on copy, cadence, deep-link.
- Surface any "this feels pushy" / "this is wrong language" /
  "the timing is off" feedback BEFORE rolling beyond the team.

**Success**:
- Each team member receives their own reminders without seeing
  anyone else's content (privacy isolation).
- Copy reads calmly in production (production CSS, production
  Arabic rendering, production push payload size).
- `firingsByStatus.sent` grows by ~1 per active team member per
  cadence.

**Failure**:
- Team feedback flags pressure copy or noisy cadence: STOP, fix
  the copy / cadence, restart the stage.
- A team member sees content that doesn't belong to them: HALT
  EVERYTHING, this is a privacy regression. Investigate.

### Stage 4 — Digest dry-run (2 days)

**Env additions**:

```
QIFT_REMINDER_DRY_RUN=true     (re-enable; gates digest worker too)
```

**Action**: trigger digest worker:

```
POST /admin/workers/run-digest
```

The worker scans queued rows, groups by user, logs what each
user WOULD see in a digest — but writes nothing and sends no
push.

**Observe**:
- The grouping makes sense (counts per category).
- The body composition reads calmly:
  - `"3 gift updates and 1 occasion reminder since you last
     checked."` ✓
  - NOT `"Missed 3 gifts!"` or `"3 unread!"` ✓
- No per-row content / no recipient names / no product names in
  the summary.

**Success**:
- `filteredDryRun > 0`.
- All `DRY-RUN would digest` log lines look sane.

### Stage 5 — Digest team activation (5 days)

**Env additions**:

```
QIFT_REMINDER_DRY_RUN=        (cleared)
QIFT_DIGEST_WORKER_ENABLED=true
```

(Reminder + digest are now both ON, scoped to the team via the
allowlist. Daily cadence by default — invoke once per day; weekly
users only get a digest on UTC Mondays.)

**Action**: daily manual trigger of BOTH workers in order:

```
POST /admin/workers/run-reminders
POST /admin/workers/run-digest
```

**Observe**:
- Team members receive both individual reminder pushes AND
  (when budget caps are hit) digest summary pushes.
- The digest summary's deep link goes to `/notifications`.
- The recursion guard holds: a queued digest summary does NOT
  reappear in the next run's pending query. (Verify with the
  status snapshot — `pendingDigest` should drop to ~0 after the
  digest worker runs.)
- Snapshot's `firingsByStatus` shows the breakdown.

**Success**:
- Both workers run cleanly each day for the entire stage.
- `pendingDigest` returns to near-zero after each digest run.
- No team member receives a duplicate digest within 24h.
- No team complaints about cadence.

**Failure**:
- `pendingDigest` keeps growing → digest worker isn't draining
  the queue. Check feature flag; check cadence gate (weekly users
  on non-Monday won't drain — that's expected, but if everyone
  is daily it shouldn't grow).
- Duplicate digest → recursion guard regression. STOP.

### Stage 6 — Sample-percent (deferred beyond canary)

```
QIFT_REMINDER_ALLOWLIST=        (cleared)
QIFT_REMINDER_USER_SAMPLE_PERCENT=10
```

**Do not enter Stage 6 within the canary.** This stage takes the
allowlist off and exposes 10% of real users. The canary's
definition of done is "team feedback is positive; no surprises
in 5+ days of Stage 5". Sample-percent is a Phase 7.3 decision.

---

## 3. Internal test-account workflow

The canary needs at least these internal accounts. They cover
the privacy + tone matrix the canonical doc requires.

| Account | Role | What it tests | Success signal |
|---|---|---|---|
| **founder** | `admin` | Admin endpoints (`/status`, `/run-*`, `/cleanup-*`); allowlist self-trigger; status snapshot reads. | All admin endpoints respond; flag state mirrors env. |
| **founder-personal** | `user` | Personal occasions + reminders; calm copy in production push; the receiver perspective on a surprise gift. | Receives reminders; never sees own admin surface. |
| **merchant-test** | `store` | Receives `GiftPreparing` / `GiftShipped` / `GiftDelivered` notifications from the SENDER perspective. Confirms sender-side body shows productName (not masked). | Merchant gets timeline pushes with product details. |
| **recipient-test** | `user` | Receives gifts. Both surprise + non-surprise. Confirms surprise-mask is applied: title generic, body=null until delivery. | Surprise gift's prep/shipped pushes show title only; body null. |
| **anonymous-gift-sender** | `user` | Sends an anonymous gift to recipient-test. Recipient should NOT see sender identity in any notification. | Recipient receives notifications with no sender name leakage. |
| **quiet-hours-user** | `user` | Has quiet hours configured 22:00–08:00 Asia/Riyadh. Receives a gift at 23:00 local. | In-app row written; push deferred to digest. `pushDeliveredAt` is null on the row. |
| **digest-only-user** | `user` | Has `digestEnabled=true`, `digestFrequency='daily'`. Accumulates queued rows; gets one daily summary. | Receives a single calm summary push per cadence; bell shows individual rows. |
| **real-time-user** | `user` | Has `digestEnabled=false`. Receives every event real-time except during quiet hours. | Pushes arrive immediately; no digest summary push for this user (worker silently marks-delivered). |

### Scenarios to verify on each account

1. **Surprise gift, preparing → shipped → delivered** on the
   recipient. Body should be `null` on prep + shipped pushes;
   delivery push reveals productName.
2. **Surprise gift, cancelled before delivery**. Body should be
   `null` on the cancellation push.
3. **Auto-default sweep fallback** on a recipient without a
   matching coverage zone. Both sides get the heads-up; recipient
   body respects surprise mask.
4. **Anonymous gift**. Recipient receives the gift but no sender
   identity leaks through any push body / title / deep-link
   preview.
5. **Quiet hours hit during a gift event**. In-app row writes;
   push doesn't fire; digest picks it up at the user's cadence.
6. **Budget cap hit**. 10 gift-update notifications in 24h → 11th
   queues for digest instead of firing real-time.
7. **Opt-out for `social` category**. Appreciation notifications
   suppress entirely (no row, no push).

### What to do if something looks off

1. **Privacy regression** (e.g. surprise productName leaks):
   HALT THE CANARY. Set `QIFT_OCCASION_REMINDER_FIRING_ENABLED=false`,
   `QIFT_DIGEST_WORKER_ENABLED=false`. Investigate the producer.
2. **Wrong cadence / tone**: stop activation; capture the team's
   feedback; revise the copy in the producer (titles) or the
   reminder body composer (`composeReminderBody` in
   `occasion-reminder-worker.service.ts`).
3. **Unexpected user receiving a push**: confirm the allowlist
   env is set correctly; check the snapshot. The default-deny
   posture should make this impossible if the env is right.

---

## 4. Observability surfaces (in order of useful)

### Tier 1 — every operator-action checkpoint

**`GET /admin/workers/status`** — single-call snapshot. Read this
BEFORE every manual trigger and AFTER. Diff the two readings.

- `flags.*` — confirm the env is set the way you intended.
- `queue.staleClaims` — non-zero → run cleanup (Section 5).
- `queue.pendingDigest` — non-zero before a digest run is
  expected; should drop after.
- `last24h.firingsByStatus` — confirm fires happened.
- `mostRecentFiring` — null means the worker hasn't written
  anything in 7 days. If you triggered the worker today and this
  is still null, fires aren't happening (orchestrator suppressing
  everything? dry-run on? candidates empty?).

### Tier 2 — per-trigger inspection

The `/run-reminders` and `/run-digest` POST responses return the
full stat block from the worker:

```
{
  ran: true,
  considered: N,
  inWindow:   N,
  fired:      N,
  digested:   N,
  suppressed: N,
  errors:     N,
  filteredAllowlist:     N,
  filteredSamplePercent: N,
  filteredDryRun:        N,
  staleClaims:           N
}
```

`considered` should be > 0 in steady state (you have reminders).
`inWindow` shows how many matched today's firing day.
`fired + digested + suppressed + filteredAllowlist +
 filteredSamplePercent + filteredDryRun + errors` should equal
`inWindow`. If they don't, log somewhere is being lost.

### Tier 3 — structured logs

Every worker run emits one structured `[reminder-worker] run
complete ...` or `[digest-worker] run complete ...` line. Grep
Railway logs for `[reminder-worker]` to see the audit trail.

The stale-claim cleanup endpoint also logs a single line per
invocation with full counts.

### Tier 4 — DB inspection (last resort)

If the snapshot doesn't answer the question, query directly:

```sql
-- Stale claims older than 24h
SELECT id, "reminderId", "occurrenceAt", "firedAt", reason
FROM "ReminderFiring"
WHERE status='claimed' AND "firedAt" < NOW() - INTERVAL '24 hours'
ORDER BY "firedAt" ASC;

-- Pending digest queue per-user
SELECT "userId", category, COUNT(*)
FROM "Notification"
WHERE "pushDeliveredAt" IS NULL
  AND type <> 'digest.summary'
GROUP BY "userId", category;

-- Last 24h firings by status
SELECT status, COUNT(*)
FROM "ReminderFiring"
WHERE "firedAt" > NOW() - INTERVAL '24 hours'
GROUP BY status;
```

The snapshot endpoint runs the same queries — but if it ever
diverges, DB is the source of truth.

---

## 5. Emergency-stop + rollback

### Hard stop (no firing, no digest, no push)

```
QIFT_OCCASION_REMINDER_FIRING_ENABLED=false   (or unset)
QIFT_DIGEST_WORKER_ENABLED=false              (or unset)
QIFT_PUSH_DELIVERY_ENABLED=false              (push kill-switch)
```

Effect:
- Reminder worker refuses to fire even when manually triggered
  (returns `skippedReason: 'feature_flag_off'`).
- Digest worker refuses to run even when manually triggered.
- Orchestrator continues writing in-app rows but the push fanout
  is suppressed. Existing gift-flow notifications still log in
  the bell; nothing reaches a device.

Reverse by removing the env values or setting back to `true` /
`unset` respectively. No deploy needed if the env is hot-reloaded
by the platform (Railway re-injects on next request).

### Soft stop (allow real-time gift flow, halt reminders only)

```
QIFT_OCCASION_REMINDER_FIRING_ENABLED=false
QIFT_DIGEST_WORKER_ENABLED=true             (or false)
QIFT_PUSH_DELIVERY_ENABLED=true             (keep gift pushes live)
```

Gift flow continues firing real-time pushes; the canary's
specific risk surface (reminders) is contained.

### Stale claim cleanup

If `queue.staleClaims > 0`, the operator can clear them. ALWAYS
DRY-RUN FIRST.

```
# Preview
POST /admin/workers/cleanup-stale-reminder-claims

# Default behaviour (recommended)
POST /admin/workers/cleanup-stale-reminder-claims?dryRun=false

# Destructive (only if you have evidence the orchestrator never
# ran for these rows — risks duplicate fire)
POST /admin/workers/cleanup-stale-reminder-claims?dryRun=false&forceClear=true
```

The default mode transitions `status='claimed'` → `status='failed'`
with `reason='stale_claim_recovered'`. The unique key stays
held; no retry; no duplicate.

The `forceClear=true` mode DELETES the rows so the next worker
run can re-fire. Use only when you have evidence the orchestrator
never ran (logs show "claim inserted" but no "orchestrator
returned" line). Duplicate-fire risk is real if you misjudge.

### Worker downtime — entire-day miss

The worker uses a strict `firingDay === today` match. If the
worker doesn't run on the exact UTC firing day, that reminder
is silently missed (the next occurrence is next year for yearly
occasions). This is documented as an explicit trade-off; the
mitigation is **operator discipline: run the worker daily during
canary**. A catch-up window can be added later (the unique
constraint makes it safe); not implemented because Phase 7 ships
manual-trigger only.

If you DO miss a firing day and want to back-fire reminders that
should have fired yesterday: don't. The audit log preserves the
miss; the recipients will see the reminder next occurrence. The
operationally-safe answer is to let it pass and resume the
daily cadence.

---

## 6. Pre-trigger checklist

Run this every time before invoking a worker manually.

1. `curl /admin/workers/status` and inspect:
   - `flags.*` matches the intended stage's env.
   - `queue.staleClaims === 0` (or you've already decided to
     leave them).
   - `mostRecentFiring` is what you expect (today's date during
     active stages; null during dry-run + stage 0).
2. Verify the env at the deploy layer (Railway dashboard) — env
   diff vs your expected stage.
3. Trigger:
   ```
   POST /admin/workers/run-reminders
   ```
4. Read the response JSON. Confirm:
   - `ran: true`
   - `errors: 0`
   - `inWindow === fired + digested + suppressed +
      filteredAllowlist + filteredSamplePercent + filteredDryRun
      + errors`
5. Re-snapshot:
   ```
   curl /admin/workers/status
   ```
   - `mostRecentFiring.firedAt` is fresh.
   - `last24h.firingsByStatus.sent` incremented by the expected
     amount.

If any step fails, follow Section 5.

---

## 7. Done criteria for the canary

The canary is "done" when ALL of these hold for 5+ consecutive
days at Stage 5:

- Snapshot `queue.staleClaims === 0` at every check.
- Snapshot `queue.pendingDigest` drains to near-zero after every
  digest run.
- `firingsByStatus` shows `sent > 0` and `failed === 0`.
- No team member has reported a privacy / tone / cadence issue.
- The recursion guard holds (digest summary never reappears in
  the next run's pending scan — verifiable via the snapshot's
  `pendingDigest`).
- The worker's response stats balance arithmetically.
- The runbook has been used end-to-end at least once with no
  surprises.

When ALL of the above is true, write a one-paragraph "canary
report" + check it into `apps/api/PHASE_7_CANARY_REPORT.md`,
then decide whether to:

1. Stay manual + expand allowlist further (most conservative).
2. Move to sample-percent rollout (Stage 6 — separate Phase 7.3
   decision).
3. Add cron scheduling (Phase 7.4 decision).

None of these decisions belong in this runbook. The runbook ends
at "canary completed; here's what we observed".

---

## 8. What this runbook does NOT cover

- Public rollout. Out of scope.
- SMS / email provider activation. Out of scope.
- Marketing notifications. Architecturally out of scope, period.
- Multi-recipient gifting notifications. Phase 7 only handles
  single-recipient gifts; multi-party gifting is documented in
  `project_multi_party_gifting_architecture.md` as a future
  topology.
- Per-user notification preferences UI. Already shipped; the
  preferences settings page is `/settings/notifications` on the
  frontend.

---

## 9. References

- `notification-orchestrator.service.ts` — the routing seam.
- `occasion-reminder-worker.service.ts` — reminder worker +
  `snapshot()` + `cleanupStaleClaims()`.
- `digest-worker.service.ts` — digest worker.
- `notification-feature-flags.ts` — all env-flag readers in one
  place.
- `notification-categories.ts` — category truth table + caps.
- `notification-privacy.ts` — surprise-mask helper.
- `admin-workers.controller.ts` — the four admin endpoints.
- `push.service.ts` — push fanout + URL allow-list.
- `PRIVATE_TESTING.md` — seed merchants + dev-flow walkthrough.

---

*This runbook is the canary's source of truth. Read it before
every operator action. Update it when the operational reality
changes. Never improvise the activation order.*
