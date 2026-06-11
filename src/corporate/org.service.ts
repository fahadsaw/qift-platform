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
    return updated;
  }
}
