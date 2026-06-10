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
  actorUserId: string;
  actorType: 'admin' | 'user' | 'system';
  action: string; // dot-namespaced, e.g. 'user.phone.change'
  targetType: 'user' | 'store' | 'system';
  targetId: string | null;
  metadata?: Record<string, unknown> | null;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private prisma: PrismaService) {}

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
