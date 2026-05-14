// Phase 7.1 — notification budget engine.
//
// Pure decision module. Inputs:
//   - the category descriptor (daily / weekly cap, mandatory flag)
//   - recent counts (already retrieved by the orchestrator)
//   - whether the user is currently in quiet hours
//   - whether the user has opted out of this category
// Output: a structured Decision the orchestrator acts on.
//
// The engine doesn't query the DB itself — keeping it pure lets
// the orchestrator batch the count query alongside its other
// reads (preferences lookup, user lookup).

import {
  type CategoryDescriptor,
  type NotificationCategory,
} from './notification-categories';

// ── Decision shape ──────────────────────────────────────────────

export type BudgetDecision =
  // Alert channels (push / email / SMS) should fire now alongside
  // the in-app row. Default path.
  | { kind: 'send_realtime' }
  // In-app row should write, but alert channels are deferred. The
  // future digest worker will pick the row up via the
  // (userId, pushDeliveredAt IS NULL) index and batch.
  | { kind: 'queue_digest'; reason: DigestReason }
  // Drop the notification entirely. No row written, no fanout.
  // Used for opted-out categories. Suppression is silent to the
  // caller — no telemetry leak about WHY (the user opted out is
  // their private setting).
  | { kind: 'suppress'; reason: SuppressReason };

export type DigestReason =
  | 'daily_cap_exceeded'
  | 'weekly_cap_exceeded'
  | 'quiet_hours'
  | 'user_digest_only';

export type SuppressReason = 'user_opted_out';

// ── Inputs ──────────────────────────────────────────────────────

export type BudgetInputs = {
  category: NotificationCategory;
  descriptor: CategoryDescriptor;
  // Count of this user's notifications in this category in the
  // last 24 hours (rolling). Caller computes via a single
  // COUNT(*) query against the (userId, category, createdAt) index.
  dailyCount: number;
  // Same for the last 7 days.
  weeklyCount: number;
  // Has the user opted out of this category? (Mandatory categories
  // are exempt; the orchestrator bypasses this engine for them
  // entirely.)
  optedOut: boolean;
  // Is the user in quiet hours right now?
  inQuietHours: boolean;
  // User's digest mode. When false, the user wants real-time
  // delivery regardless of quiet hours / budget (the calm-UX
  // baseline turned off). Default true.
  digestEnabled: boolean;
};

// ── The decision ────────────────────────────────────────────────

export function evaluateBudget(input: BudgetInputs): BudgetDecision {
  const {
    descriptor,
    optedOut,
    dailyCount,
    weeklyCount,
    inQuietHours,
    digestEnabled,
  } = input;

  // Mandatory categories bypass EVERYTHING. The orchestrator
  // shouldn't call this engine for them, but defence-in-depth:
  // even if it does, we always send.
  if (descriptor.mandatory) {
    return { kind: 'send_realtime' };
  }

  // Opt-out is the first gate. A user who said "don't send me X"
  // gets no row, no push, no email.
  if (optedOut) {
    return { kind: 'suppress', reason: 'user_opted_out' };
  }

  // Daily cap. Once exceeded, the in-app row still writes (the
  // orchestrator decides) but alert channels defer to digest.
  if (descriptor.dailyCap !== null && dailyCount >= descriptor.dailyCap) {
    return { kind: 'queue_digest', reason: 'daily_cap_exceeded' };
  }

  // Weekly cap.
  if (descriptor.weeklyCap !== null && weeklyCount >= descriptor.weeklyCap) {
    return { kind: 'queue_digest', reason: 'weekly_cap_exceeded' };
  }

  // Quiet hours. Non-critical traffic defers to the next batch.
  // (Mandatory categories already returned above.)
  if (inQuietHours) {
    return { kind: 'queue_digest', reason: 'quiet_hours' };
  }

  // `digestEnabled` is intentionally NOT a gate here. It governs
  // the digest WORKER's summary-push behaviour (see digest-
  // worker.service.ts), not the orchestrator's queue/send
  // decision. Quiet hours + budget caps still queue rows for a
  // `digestEnabled=false` user; the digest worker then marks
  // those rows delivered without firing a summary push. Keeping
  // this comment so a future reader doesn't add a redundant
  // `if (!digestEnabled)` branch here.
  //
  // The function argument is still surfaced (rather than dropped)
  // because callers serialise the full BudgetInputs into audit
  // logs — removing it would lose telemetry context.
  void digestEnabled;

  // All gates passed — alert channels fire now.
  return { kind: 'send_realtime' };
}
