import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { normalizePhone } from '../auth/phone-normalize';
import { isBetaGateEnabled } from './beta-gate-flag';
import {
  emailDomainOf,
  generateBetaCode,
  isBetaAllowlistKind,
  normalizeAllowlistDomain,
  normalizeAllowlistEmail,
  normalizeBetaCode,
  type BetaAllowlistKind,
} from './beta-code';

// Outcome of the registration-time gate decision. The AuthService uses
// this to know whether (and how) to redeem a code inside the same
// transaction as the user.create it admits.
export type BetaRegistrationDecision =
  | { mode: 'open' } // gate OFF — register freely
  | { mode: 'allowlist' } // email / domain / phone is allowlisted
  | { mode: 'code'; codeId: string; maxUses: number | null }; // code redeem pending

@Injectable()
export class BetaAccessService {
  constructor(
    private prisma: PrismaService,
    // PR 7 — every admin mutation on the gate persists to AuditLog.
    private audit: AuditService,
  ) {}

  isGateEnabled(): boolean {
    return isBetaGateEnabled();
  }

  // ── Registration-time gate ─────────────────────────────────────────
  //
  // Read-only. Decides whether this (email, phone, betaCode) triple may
  // register, and throws a 403 with a stable `code` if not. The actual
  // code redemption (usedCount increment + redemption row) is deferred
  // to applyRedemption() so it can run atomically inside the caller's
  // user-create transaction.
  async decideRegistration(input: {
    email: string | null;
    phone: string;
    betaCode?: string | null;
  }): Promise<BetaRegistrationDecision> {
    // Gate OFF → fully open, no DB hit. Existing tests + dev signups
    // take this branch.
    if (!isBetaGateEnabled()) {
      return { mode: 'open' };
    }

    // 1. Allowlist. Any of {exact email, email domain, phone} matching
    //    admits the registrant — no code required.
    if (await this.matchesAllowlist(input.email, input.phone)) {
      return { mode: 'allowlist' };
    }

    // 2. Invite code.
    const raw = input.betaCode?.trim();
    if (!raw) {
      throw this.denied(
        'beta_required',
        'التسجيل مغلق حالياً — يلزم رمز دعوة للانضمام',
      );
    }
    const code = normalizeBetaCode(raw);
    const row = await this.prisma.betaInviteCode.findUnique({
      where: { code },
    });
    // Unknown OR disabled both collapse to `beta_code_invalid` so a
    // disabled code is indistinguishable from a never-existed one (no
    // "this code exists but is off" signal).
    if (!row || row.disabledAt) {
      throw this.denied('beta_code_invalid', 'رمز الدعوة غير صالح');
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw this.denied('beta_code_expired', 'انتهت صلاحية رمز الدعوة');
    }
    if (row.maxUses !== null && row.usedCount >= row.maxUses) {
      throw this.denied(
        'beta_code_exhausted',
        'تم استهلاك رمز الدعوة بالكامل',
      );
    }
    return { mode: 'code', codeId: row.id, maxUses: row.maxUses };
  }

  // Apply a 'code' decision atomically inside the caller's user-create
  // transaction. No-op for 'open' / 'allowlist'.
  //
  // CONCURRENCY: the conditional updateMany re-evaluates
  // `usedCount < maxUses` under the Postgres row lock, so two concurrent
  // redemptions of the LAST remaining slot cannot both succeed — the
  // loser sees res.count === 0 and throws, rolling back its whole
  // transaction (including the user.create). `disabledAt: null` is
  // re-checked here in case an operator disabled the code between the
  // decision and the commit.
  async applyRedemption(
    tx: Prisma.TransactionClient,
    decision: BetaRegistrationDecision,
    userId: string,
  ): Promise<void> {
    if (decision.mode !== 'code') return;

    const where: Prisma.BetaInviteCodeWhereInput = {
      id: decision.codeId,
      disabledAt: null,
    };
    if (decision.maxUses !== null) {
      where.usedCount = { lt: decision.maxUses };
    }
    const res = await tx.betaInviteCode.updateMany({
      where,
      data: { usedCount: { increment: 1 } },
    });
    if (res.count === 0) {
      throw this.denied(
        'beta_code_exhausted',
        'تم استهلاك رمز الدعوة بالكامل',
      );
    }
    // Idempotent via the @@unique([codeId, userId]) index — a retried
    // register for the same user against the same code would surface a
    // P2002 here, which is the correct "already redeemed" signal.
    await tx.betaInviteRedemption.create({
      data: { codeId: decision.codeId, userId },
    });
  }

  private async matchesAllowlist(
    email: string | null,
    phone: string,
  ): Promise<boolean> {
    // Phone is always present (register requires a normalised E.164).
    const ors: Prisma.BetaAllowlistEntryWhereInput[] = [
      { kind: 'phone', value: phone },
    ];
    if (email) {
      ors.push({ kind: 'email', value: email });
      const domain = emailDomainOf(email);
      if (domain) ors.push({ kind: 'email_domain', value: domain });
    }
    const hit = await this.prisma.betaAllowlistEntry.findFirst({
      where: { OR: ors },
      select: { id: true },
    });
    return !!hit;
  }

  // 403 Forbidden with the auth-flow's structured envelope
  // ({ statusCode, code, message }), so the frontend switches on `code`
  // exactly like the username_taken / phone_taken register errors.
  private denied(code: string, message: string): HttpException {
    return new HttpException(
      { statusCode: HttpStatus.FORBIDDEN, code, message },
      HttpStatus.FORBIDDEN,
    );
  }

  // ── Admin management ───────────────────────────────────────────────
  // Every method below is reached only through the beta.manage-gated
  // controller; no additional auth check is needed here.

  getStatus(): { gateEnabled: boolean } {
    return { gateEnabled: isBetaGateEnabled() };
  }

  listCodes() {
    return this.prisma.betaInviteCode.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async createCode(
    input: {
      code?: string;
      label?: string;
      maxUses?: number | null;
      expiresAt?: string | null;
    },
    createdBy: string,
  ) {
    const code = input.code
      ? normalizeBetaCode(input.code)
      : generateBetaCode();
    if (!code) {
      throw new BadRequestException('beta_code_required');
    }

    // maxUses: null/undefined = unlimited. A positive integer is a hard
    // cap. Reject <= 0 (a zero-use code is a footgun that admits nobody).
    let maxUses: number | null = null;
    if (input.maxUses !== undefined && input.maxUses !== null) {
      if (!Number.isInteger(input.maxUses) || input.maxUses < 1) {
        throw new BadRequestException('beta_max_uses_invalid');
      }
      maxUses = input.maxUses;
    }

    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      const d = new Date(input.expiresAt);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException('beta_expires_at_invalid');
      }
      expiresAt = d;
    }

    let created;
    try {
      created = await this.prisma.betaInviteCode.create({
        data: {
          code,
          label: input.label?.trim() || null,
          maxUses,
          expiresAt,
          createdBy,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('beta_code_taken');
      }
      throw err;
    }
    await this.audit.record({
      actorUserId: createdBy,
      actorType: 'admin',
      action: 'admin.beta.code_create',
      targetType: 'system',
      targetId: created.id,
      metadata: { label: created.label, maxUses, expiresAt },
    });
    return created;
  }

  async setCodeDisabled(actorUserId: string, id: string, disabled: boolean) {
    const existing = await this.prisma.betaInviteCode.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('beta_code_not_found');
    }
    const updated = await this.prisma.betaInviteCode.update({
      where: { id },
      data: { disabledAt: disabled ? new Date() : null },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'admin',
      action: disabled ? 'admin.beta.code_disable' : 'admin.beta.code_enable',
      targetType: 'system',
      targetId: id,
      metadata: { label: existing.label },
    });
    return updated;
  }

  listAllowlist() {
    return this.prisma.betaAllowlistEntry.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async addAllowlistEntry(
    input: { kind: string; value: string; label?: string },
    createdBy: string,
  ) {
    if (!isBetaAllowlistKind(input.kind)) {
      throw new BadRequestException('beta_allowlist_kind_invalid');
    }
    const value = this.normalizeAllowlistValue(input.kind, input.value);
    if (!value) {
      throw new BadRequestException('beta_allowlist_value_invalid');
    }
    let created;
    try {
      created = await this.prisma.betaAllowlistEntry.create({
        data: {
          kind: input.kind,
          value,
          label: input.label?.trim() || null,
          createdBy,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('beta_allowlist_duplicate');
      }
      throw err;
    }
    // The allowlist value (email/domain/phone) is stored in the
    // audit metadata for forensics — the table is admin-read-only,
    // same posture as the change-phone old→new values.
    await this.audit.record({
      actorUserId: createdBy,
      actorType: 'admin',
      action: 'admin.beta.allowlist_add',
      targetType: 'system',
      targetId: created.id,
      metadata: { kind: input.kind, value },
    });
    return created;
  }

  async removeAllowlistEntry(actorUserId: string, id: string) {
    const existing = await this.prisma.betaAllowlistEntry.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('beta_allowlist_not_found');
    }
    await this.prisma.betaAllowlistEntry.delete({ where: { id } });
    await this.audit.record({
      actorUserId,
      actorType: 'admin',
      action: 'admin.beta.allowlist_remove',
      targetType: 'system',
      targetId: id,
      metadata: { kind: existing.kind, value: existing.value },
    });
    return { ok: true };
  }

  // Normalise an allowlist value to the exact stored/queried form for
  // its kind. Returns null when the value is unusable for that kind, so
  // the caller can surface a clean 400 instead of inserting junk.
  private normalizeAllowlistValue(
    kind: BetaAllowlistKind,
    raw: string,
  ): string | null {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) return null;
    if (kind === 'phone') {
      // Same canonicalisation register applies, so an allowlisted phone
      // matches the normalised E.164 the gate probes with.
      return normalizePhone(trimmed);
    }
    if (kind === 'email') {
      const lowered = normalizeAllowlistEmail(trimmed);
      // Must have a domain to be a sane exact-email entry.
      return emailDomainOf(lowered) ? lowered : null;
    }
    // email_domain
    const domain = normalizeAllowlistDomain(trimmed);
    // Light sanity: reject obvious non-domains (no dot). Full domain
    // validation is overkill for an operator-curated list.
    return domain.includes('.') ? domain : null;
  }
}
