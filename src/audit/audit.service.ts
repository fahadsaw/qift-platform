// AuditService — the persistent audit trail (PR 5 foundation).
//
// One narrow primitive: record(). The input shape deliberately
// matches AdminService.recordAuditTODO so the deferred admin
// call-sites swap onto this mechanically (PR 7).
//
// FAILURE POSTURE: best-effort. An audit-write failure must never
// break the user-facing action that triggered it — the action has
// already happened (or is about to commit); failing it now would
// punish the user for our bookkeeping. Failures are logged loudly
// with the full action context so ops can backfill from request
// logs. This mirrors the house pattern for OTP-row deletes and
// attempt increments.
//
// PII: metadata MAY carry old/new contact values (change-phone /
// change-email need them for account-takeover forensics). The
// table is admin-read-only; never expose rows on public surfaces.

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditRecordInput = {
  // null for system actors (background workers) — there is no human
  // behind the action. The column is nullable in production already.
  actorUserId: string | null;
  actorType: 'admin' | 'user' | 'system';
  action: string; // dot-namespaced, e.g. 'user.phone.change'
  targetType: 'user' | 'store' | 'system' | 'organization';
  targetId: string | null;
  metadata?: Record<string, unknown> | null;
};

// Scope A (Lane 2 PR 3): keys the ledger's PII denylist posture —
// guaranteed financial audits must never carry personal data.
const PII_DENYLIST = new Set([
  'recipientname', 'name', 'phone', 'phonenumber', 'email', 'address',
  'addressline', 'city', 'district', 'lat', 'lng', 'location', 'note',
  'giftmessage',
]);
function stripPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPii);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_DENYLIST.has(k.toLowerCase())) continue;
      out[k] = stripPii(v);
    }
    return out;
  }
  return value;
}

// The narrow client shape both prisma and a transaction handle satisfy.
type AuditClient = {
  auditLog: {
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private prisma: PrismaService) {}

  // ── Scope A (Lane 2 PR 3): GUARANTEED financial audit ────────────
  //
  // High-sensitivity financial mutations must never complete while
  // their audit evidence is silently lost (founder mandate). This
  // primitive is the constitutionally safe design 1: the audit row
  // rides the SAME database transaction when the caller passes its
  // `tx`; callers whose mutation is already committed (idempotent,
  // re-runnable completion tails) call it without a tx and its
  // failure THROWS — the §18.2 heal lane re-attempts with the same
  // deterministic key.
  //
  // Laws: NO best-effort (errors propagate); deterministic
  // occurrence-anchored `auditKey` (a retry collides P2002 and
  // returns the existing row — never a duplicate); PII stripped from
  // metadata (denylist, ledger posture); canonical references travel
  // in metadata as plain strings.
  async recordGuaranteed(
    input: AuditRecordInput & { auditKey: string },
    tx?: unknown,
  ): Promise<void> {
    if (!input.auditKey || !input.auditKey.trim()) {
      throw new Error('audit_key_required');
    }
    const client = (tx as AuditClient | undefined) ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          auditKey: input.auditKey,
          actorUserId: input.actorUserId,
          actorType: input.actorType,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          metadata:
            input.metadata == null
              ? Prisma.JsonNull
              : (stripPii(input.metadata) as Prisma.InputJsonValue),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        // Deterministic idempotency: the act was already audited —
        // the existing row stands, nothing duplicates.
        return;
      }
      // NO swallow: the caller's transaction rolls back (in-tx) or
      // the caller's idempotent tail retries (post-commit).
      throw err;
    }
  }

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actorType: input.actorType,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          metadata:
            input.metadata == null
              ? Prisma.JsonNull
              : (input.metadata as Prisma.InputJsonValue),
        },
      });
    } catch (err) {
      // Loud, structured, greppable — but never thrown.
      this.logger.error(
        `[audit-failed] ${input.action} actor=${input.actorUserId} ` +
          `target=${input.targetId ?? 'system'} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
