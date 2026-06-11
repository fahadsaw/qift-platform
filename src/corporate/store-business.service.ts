// StoreBusinessService — Qift Business eligibility workflow (B1).
//
// THE INDEPENDENCE INVARIANT, stated once and enforced here:
// consumer approval never implies business approval, and business
// review never touches Store.status. A store supplies corporate
// campaigns only when BOTH are true:
//
//   Store.status === 'approved'           (consumer review pipeline)
//   StoreBusinessProfile.status === 'approved'   (this pipeline)
//
// isBusinessEligible() is the single seam every future supply
// feature (BusinessListing in B2, the business gift picker in B3)
// must consult — never re-derive eligibility elsewhere.
//
// Workflow (mirrors the proven Store/Organization review pattern):
//   (no row) → applied → approved / rejected
//   approved → suspended → approved (reinstate)
//   rejected → applied (re-application updates the same row)
//
// B1 is ops-initiated end to end (concierge pilot): ops files the
// application on the merchant's behalf. Merchant self-serve apply
// is B5, gated behind Pilot #1 feedback.

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const PROFILE_STATUSES = [
  'applied',
  'approved',
  'rejected',
  'suspended',
] as const;

const REVIEW_ACTIONS = ['approve', 'reject', 'suspend', 'reinstate'] as const;
export type BusinessReviewAction = (typeof REVIEW_ACTIONS)[number];

// action → (allowed current status, next status). Explicit table
// beats clever transitions in a review pipeline.
const TRANSITIONS: Record<
  BusinessReviewAction,
  { from: string; to: string; reasonRequired: boolean }
> = {
  approve: { from: 'applied', to: 'approved', reasonRequired: false },
  reject: { from: 'applied', to: 'rejected', reasonRequired: true },
  suspend: { from: 'approved', to: 'suspended', reasonRequired: true },
  reinstate: { from: 'suspended', to: 'approved', reasonRequired: false },
};

const PROFILE_SELECT = {
  id: true,
  storeId: true,
  status: true,
  appliedBy: true,
  appliedAt: true,
  reviewedAt: true,
  reviewedBy: true,
  reason: true,
  store: { select: { id: true, name: true, city: true, status: true } },
} as const;

@Injectable()
export class StoreBusinessService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ── The eligibility seam (B2+ consumes this, nothing else) ──────
  async isBusinessEligible(storeId: string): Promise<boolean> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { status: true, businessProfile: { select: { status: true } } },
    });
    return (
      store?.status === 'approved' &&
      store.businessProfile?.status === 'approved'
    );
  }

  // ── Application (ops-initiated in B1) ───────────────────────────
  //
  // Requires the store to be consumer-approved first: business is a
  // layer ON TOP of a vetted merchant, not a parallel onboarding
  // path. (Independence cuts the other way: consumer approval never
  // GRANTS business access.)
  async apply(actorUserId: string, storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, status: true, businessProfile: true },
    });
    if (!store) throw new NotFoundException('store_not_found');
    if (store.status !== 'approved') {
      throw new BadRequestException('store_not_consumer_approved');
    }

    const existing = store.businessProfile;
    if (existing && existing.status !== 'rejected') {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: 'business_application_exists',
          message: `Store already has a business profile (${existing.status})`,
        },
        HttpStatus.CONFLICT,
      );
    }

    const profile = existing
      ? // Re-application after rejection: same row, fresh review state.
        await this.prisma.storeBusinessProfile.update({
          where: { id: existing.id },
          data: {
            status: 'applied',
            appliedBy: actorUserId,
            appliedAt: new Date(),
            reviewedAt: null,
            reviewedBy: null,
            reason: null,
          },
          select: PROFILE_SELECT,
        })
      : await this.prisma.storeBusinessProfile.create({
          data: { storeId, appliedBy: actorUserId },
          select: PROFILE_SELECT,
        });

    await this.audit.record({
      actorUserId,
      actorType: 'admin',
      action: 'admin.store.business_apply',
      targetType: 'store',
      targetId: storeId,
      metadata: { profileId: profile.id, reapplication: !!existing },
    });
    return profile;
  }

  // ── Review (separate trail from consumer store review) ──────────
  async review(
    adminUserId: string,
    storeId: string,
    action: BusinessReviewAction,
    reason: string | null,
  ) {
    const transition = TRANSITIONS[action];
    if (!transition) {
      throw new BadRequestException('business_review_action_invalid');
    }
    const trimmedReason = reason?.trim() || null;
    if (transition.reasonRequired && !trimmedReason) {
      throw new BadRequestException('business_review_reason_required');
    }

    const profile = await this.prisma.storeBusinessProfile.findUnique({
      where: { storeId },
      select: { id: true, status: true },
    });
    if (!profile) throw new NotFoundException('business_profile_not_found');
    if (profile.status !== transition.from) {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: 'business_review_wrong_state',
          message: `Cannot ${action} a profile in '${profile.status}'`,
        },
        HttpStatus.CONFLICT,
      );
    }

    // Conditional update: a racing reviewer loses cleanly.
    const flipped = await this.prisma.storeBusinessProfile.updateMany({
      where: { id: profile.id, status: transition.from },
      data: {
        status: transition.to,
        reviewedAt: new Date(),
        reviewedBy: adminUserId,
        reason: transition.reasonRequired ? trimmedReason : null,
      },
    });
    if (flipped.count === 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.CONFLICT,
          code: 'business_review_wrong_state',
          message: 'Profile state changed concurrently',
        },
        HttpStatus.CONFLICT,
      );
    }

    await this.audit.record({
      actorUserId: adminUserId,
      actorType: 'admin',
      action: 'admin.store.business_review',
      targetType: 'store',
      targetId: storeId,
      metadata: { reviewAction: action, reason: trimmedReason },
    });
    return this.prisma.storeBusinessProfile.findUnique({
      where: { storeId },
      select: PROFILE_SELECT,
    });
  }

  // ── Queue reads ──────────────────────────────────────────────────
  list(status?: string) {
    const filter =
      status && (PROFILE_STATUSES as readonly string[]).includes(status)
        ? { status }
        : {};
    return this.prisma.storeBusinessProfile.findMany({
      where: filter,
      select: PROFILE_SELECT,
      orderBy: { appliedAt: 'desc' },
      take: 100,
    });
  }

  async get(storeId: string) {
    const profile = await this.prisma.storeBusinessProfile.findUnique({
      where: { storeId },
      select: PROFILE_SELECT,
    });
    if (!profile) throw new NotFoundException('business_profile_not_found');
    return profile;
  }
}
