// OrgService — Organization lifecycle + seats (Corporate Foundation
// PR 1; Corporate Core v2 §2.1/§2.2).
//
// Review lifecycle mirrors the merchant Store pipeline:
//   draft → submitted → approved / rejected / changes_requested
//   approved → suspended (and back) is ops-only.
// Org records survive user purges (plain-TEXT actor columns); every
// state change writes the AuditLog.

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  NotificationsService,
  NotificationType,
} from '../notifications/notifications.service';

const ORG_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'changes_requested',
  'suspended',
] as const;
type OrgStatus = (typeof ORG_STATUSES)[number];

// Submission is allowed only from these states (mirror of the
// merchant resubmit rule).
const SUBMITTABLE: ReadonlySet<string> = new Set([
  'draft',
  'changes_requested',
]);

const REVIEW_ACTIONS = ['approve', 'reject', 'request_changes'] as const;
export type OrgReviewAction = (typeof REVIEW_ACTIONS)[number];

// Roles an owner may GRANT (PR 7a). 'owner' is deliberately absent:
// there is exactly one owner (minted at org creation) and no API
// path mints another — which is also what makes self-elevation
// unrepresentable (you cannot be re-added while seated, and the
// role you could be re-added with is never 'owner').
const GRANTABLE_SEAT_ROLES = ['admin', 'approver', 'viewer'] as const;
export type GrantableSeatRole = (typeof GRANTABLE_SEAT_ROLES)[number];

export type CreateOrgInput = {
  legalName?: string;
  displayName?: string;
  displayNameAr?: string;
  crNumber?: string;
  vatNumber?: string;
  billingEmail?: string;
  billingAddress?: string;
};

// Org-plane projection. Deliberately excludes reviewer identity —
// org users see WHAT happened (status, reason), not WHICH operator
// did it.
const ORG_SELECT = {
  id: true,
  legalName: true,
  displayName: true,
  displayNameAr: true,
  crNumber: true,
  vatNumber: true,
  billingEmail: true,
  billingAddress: true,
  status: true,
  rejectionReason: true,
  submittedAt: true,
  createdAt: true,
} as const;

// Admin projection adds the operational fields.
const ADMIN_ORG_SELECT = {
  ...ORG_SELECT,
  riskTier: true,
  createdBy: true,
  reviewedAt: true,
  reviewedBy: true,
} as const;

@Injectable()
export class OrgService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  // ── Org plane ─────────────────────────────────────────────────────

  // Create a draft org. The creator becomes the OWNER seat in the
  // same transaction — an org without an owner is unreachable.
  async createOrg(creatorUserId: string, body: CreateOrgInput) {
    const legalName = body.legalName?.trim();
    const displayName = body.displayName?.trim();
    if (!legalName || legalName.length < 3) {
      throw new BadRequestException('org_legal_name_required');
    }
    if (!displayName || displayName.length < 2) {
      throw new BadRequestException('org_display_name_required');
    }

    const org = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          legalName,
          displayName,
          displayNameAr: body.displayNameAr?.trim() || null,
          crNumber: body.crNumber?.trim() || null,
          vatNumber: body.vatNumber?.trim() || null,
          billingEmail: body.billingEmail?.trim().toLowerCase() || null,
          billingAddress: body.billingAddress?.trim() || null,
          createdBy: creatorUserId,
        },
        select: ORG_SELECT,
      });
      await tx.orgUser.create({
        data: {
          orgId: created.id,
          userId: creatorUserId,
          role: 'owner',
          acceptedAt: new Date(),
        },
      });
      return created;
    });

    await this.audit.record({
      actorUserId: creatorUserId,
      actorType: 'user',
      action: 'org.create',
      targetType: 'organization',
      targetId: org.id,
      metadata: { legalName },
    });
    return org;
  }

  // Orgs where the viewer holds an active seat. The org-plane
  // listing surface — never lists orgs the viewer isn't seated in.
  async myOrgs(userId: string) {
    const seats = await this.prisma.orgUser.findMany({
      where: { userId, revokedAt: null },
      select: { role: true, org: { select: ORG_SELECT } },
      orderBy: { createdAt: 'asc' },
    });
    return seats.map((s) => ({ ...s.org, myRole: s.role }));
  }

  // Single org for a seated member. orgId comes from the
  // guard-attached context — tenant scoping happened upstream.
  async getOrg(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: ORG_SELECT,
    });
    if (!org) throw new NotFoundException('org_not_found');
    return org;
  }

  // Submit for review (owner/admin; enforced by the route guard).
  async submitOrg(actorUserId: string, orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, status: true, crNumber: true },
    });
    if (!org) throw new NotFoundException('org_not_found');
    if (!SUBMITTABLE.has(org.status)) {
      throw new BadRequestException('org_not_submittable');
    }
    // CR is the review pipeline's anchor document — require it at
    // submission, not at draft creation (drafts may be incomplete).
    if (!org.crNumber) {
      throw new BadRequestException('org_cr_required');
    }
    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      data: { status: 'submitted', submittedAt: new Date() },
      select: ORG_SELECT,
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.submit',
      targetType: 'organization',
      targetId: orgId,
    });
    return updated;
  }

  // ── Seat management (PR 7a; owner-only at the controller) ────────

  // Active seats with their usernames. OrgUser.userId is plain TEXT
  // (no FK — purge survivability), so the username join is a manual
  // second read; a purged user renders with qiftUsername null.
  async listMembers(orgId: string) {
    const seats = await this.prisma.orgUser.findMany({
      where: { orgId, revokedAt: null },
      select: {
        id: true,
        userId: true,
        role: true,
        invitedBy: true,
        acceptedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: seats.map((s) => s.userId) } },
      select: { id: true, qiftUsername: true },
    });
    const usernameById = new Map(users.map((u) => [u.id, u.qiftUsername]));
    return seats.map((s) => ({
      ...s,
      qiftUsername: usernameById.get(s.userId) ?? null,
    }));
  }

  // Seat a colleague by @qiftUsername. Owner-only (route guard).
  // Re-adding a previously revoked member REVIVES their seat with
  // the new role; an ACTIVE seat conflicts — there is deliberately
  // no in-place role change, so nobody (including a seated admin
  // who somehow reached this code) can re-add themselves to a
  // different role. Role 'owner' is never grantable.
  async addMember(
    actorUserId: string,
    orgId: string,
    body: { qiftUsername?: string; role?: string },
  ) {
    const role = body.role;
    if (
      !role ||
      !(GRANTABLE_SEAT_ROLES as readonly string[]).includes(role)
    ) {
      throw new BadRequestException('member_role_invalid');
    }
    const username = body.qiftUsername
      ?.trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!username) {
      throw new BadRequestException('member_username_required');
    }
    const user = await this.prisma.user.findFirst({
      where: { qiftUsername: username, deletedAt: null },
      select: { id: true, qiftUsername: true },
    });
    if (!user) throw new NotFoundException('user_not_found');

    const existing = await this.prisma.orgUser.findUnique({
      where: { orgId_userId: { orgId, userId: user.id } },
      select: { id: true, revokedAt: true },
    });
    if (existing && existing.revokedAt === null) {
      // Covers self-re-add too: an active seat (any role, owner
      // included) can never be re-granted — revoke first, by the
      // owner, then re-add.
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: 'member_already_seated',
          message: 'This user already holds an active seat',
        },
        HttpStatus.CONFLICT,
      );
    }

    const seat = existing
      ? await this.prisma.orgUser.update({
          where: { id: existing.id },
          data: {
            role,
            revokedAt: null,
            invitedBy: actorUserId,
            acceptedAt: new Date(),
          },
          select: { id: true, userId: true, role: true, createdAt: true },
        })
      : await this.prisma.orgUser.create({
          data: {
            orgId,
            userId: user.id,
            role,
            invitedBy: actorUserId,
            acceptedAt: new Date(),
          },
          select: { id: true, userId: true, role: true, createdAt: true },
        });

    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.member.add',
      targetType: 'organization',
      targetId: orgId,
      metadata: {
        seatId: seat.id,
        memberUserId: user.id,
        role,
        revived: !!existing,
      },
    });
    return { ...seat, qiftUsername: user.qiftUsername };
  }

  // Soft-revoke a seat. Keyed (id, orgId, active) — a seat in
  // another org is indistinguishable from a missing one. The owner
  // seat is irrevocable (which also means the owner can never
  // revoke themselves): an org without an owner would be
  // unreachable.
  async revokeMember(actorUserId: string, orgId: string, seatId: string) {
    const seat = await this.prisma.orgUser.findFirst({
      where: { id: seatId, orgId, revokedAt: null },
      select: { id: true, userId: true, role: true },
    });
    if (!seat) throw new NotFoundException('member_not_found');
    if (seat.userId === actorUserId) {
      throw new BadRequestException('cannot_revoke_self');
    }
    if (seat.role === 'owner') {
      throw new BadRequestException('cannot_revoke_owner');
    }
    const result = await this.prisma.orgUser.updateMany({
      where: { id: seatId, orgId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('member_not_found');

    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.member.revoke',
      targetType: 'organization',
      targetId: orgId,
      metadata: { seatId, memberUserId: seat.userId, role: seat.role },
    });
    return { ok: true };
  }

  // ── Admin plane (org.review-gated at the controller) ─────────────

  listOrgsForReview(status?: string) {
    const filter =
      status && (ORG_STATUSES as readonly string[]).includes(status)
        ? { status }
        : {};
    return this.prisma.organization.findMany({
      where: filter,
      select: ADMIN_ORG_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async adminGetOrg(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        ...ADMIN_ORG_SELECT,
        seats: {
          where: { revokedAt: null },
          select: { userId: true, role: true, createdAt: true },
        },
      },
    });
    if (!org) throw new NotFoundException('org_not_found');
    return org;
  }

  // approve / reject / request_changes — reject + request_changes
  // require a reason (the org sees it verbatim; write it for them).
  async reviewOrg(
    adminUserId: string,
    orgId: string,
    action: OrgReviewAction,
    reason: string | null,
  ) {
    if (!(REVIEW_ACTIONS as readonly string[]).includes(action)) {
      throw new BadRequestException('org_review_action_invalid');
    }
    const trimmedReason = reason?.trim() || null;
    if (action !== 'approve' && !trimmedReason) {
      throw new BadRequestException('org_review_reason_required');
    }
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, status: true },
    });
    if (!org) throw new NotFoundException('org_not_found');
    if (org.status !== 'submitted') {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: 'org_not_in_review',
          message: 'Only submitted organizations can be reviewed',
        },
        HttpStatus.CONFLICT,
      );
    }

    const nextStatus: OrgStatus =
      action === 'approve'
        ? 'approved'
        : action === 'reject'
          ? 'rejected'
          : 'changes_requested';

    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        status: nextStatus,
        rejectionReason: action === 'approve' ? null : trimmedReason,
        reviewedAt: new Date(),
        reviewedBy: adminUserId,
      },
      select: ADMIN_ORG_SELECT,
    });
    await this.audit.record({
      actorUserId: adminUserId,
      actorType: 'admin',
      action: 'admin.org.review',
      targetType: 'organization',
      targetId: orgId,
      metadata: { reviewAction: action, reason: trimmedReason },
    });

    // Tell the OWNER (audit Q4) — without this, the submitter has
    // to poll /org for days. Fire-and-forget: a notification
    // failure must never fail the review itself.
    const owner = await this.prisma.orgUser.findFirst({
      where: { orgId, role: 'owner', revokedAt: null },
      select: { userId: true },
    });
    if (owner) {
      const title =
        action === 'approve'
          ? 'تم اعتماد ملف شركتك 🎉'
          : action === 'reject'
            ? 'لم يُعتمد ملف شركتك'
            : 'مطلوب تعديلات على ملف شركتك';
      void this.notifications.trigger({
        userId: owner.userId,
        type: NotificationType.OrgReviewDecision,
        title,
        body: action === 'approve' ? updated.displayName : trimmedReason,
        link: '/org',
      });
    }
    return updated;
  }
}
