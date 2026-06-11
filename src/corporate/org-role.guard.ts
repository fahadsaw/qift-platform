// OrgRoleGuard — the org-plane authorization boundary (Corporate
// Foundation PR 1; Corporate Core v2 §7).
//
// Mirrors OpsRoleGuard mechanics (decorator metadata + guard), with
// two deliberate differences:
//
//   1. TENANT SCOPING IS THE GUARD'S JOB. The guard resolves the
//      :orgId route param, loads the caller's ACTIVE seat for that
//      exact org, and attaches { orgId, role, orgUserId } to the
//      request as `orgContext`. Handlers and services take orgId
//      from this context — never from the body — so cross-tenant
//      reads are unrepresentable at the handler layer.
//
//   2. NO-SEAT IS A 404, NOT A 403. A non-member must not learn
//      that an org id exists (anti-enumeration — same posture as
//      blocked-user profiles). Wrong-ROLE with a valid seat is a
//      403: the member already knows the org exists.
//
// Stacks on JwtAuthGuard (req.user populated). Routes without the
// decorator are NOT org-scoped by this guard — org-plane
// controllers must decorate every :orgId route.

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { orgRoleSatisfies, type OrgRole } from './org-roles';

const META_KEY = 'qift:orgRoles';

// Allowed roles for the route. Empty call (`@RequireOrgRole()`)
// means "any active seat" — read surfaces for every member.
export const RequireOrgRole = (...roles: OrgRole[]) =>
  SetMetadata(META_KEY, roles);

export type OrgContext = {
  orgId: string;
  role: OrgRole;
  orgUserId: string;
};

@Injectable()
export class OrgRoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const allowed = this.reflector.getAllAndOverride<OrgRole[] | undefined>(
      META_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allowed === undefined) return true;

    const req = ctx.switchToHttp().getRequest<{
      user?: { userId: string };
      params?: Record<string, string>;
      orgContext?: OrgContext;
    }>();
    const userId = req.user?.userId;
    const orgId = req.params?.orgId;
    if (!userId || !orgId) {
      // Misconfigured route (decorator without :orgId param) fails
      // closed rather than open.
      throw new NotFoundException('org_not_found');
    }

    const seat = await this.prisma.orgUser.findFirst({
      where: { orgId, userId, revokedAt: null },
      select: { id: true, role: true },
    });
    if (!seat) {
      // No active seat → indistinguishable from "no such org".
      throw new NotFoundException('org_not_found');
    }

    if (allowed.length > 0 && !orgRoleSatisfies(seat.role, allowed)) {
      throw new ForbiddenException('org_role_insufficient');
    }

    req.orgContext = {
      orgId,
      role: seat.role as OrgRole,
      orgUserId: seat.id,
    };
    return true;
  }
}
