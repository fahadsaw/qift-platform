import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  hasOpsPermission,
  isOpsRole,
  type OpsPermission,
  type OpsRole,
} from './ops-roles';

// Read + write surface for OpsRoleAssignment. Used by the
// OpsRoleGuard for permission checks at request time and by the
// admin endpoints that grant / revoke roles.
//
// The "is this user even allowed to hold ops roles?" gate is
// User.role === 'admin'. We enforce that on assignment but not
// on read (read returns whatever assignments exist; if the
// user was demoted from admin their assignments stay but are
// inert because the AdminGuard upstream would reject them).
@Injectable()
export class OpsRolesService {
  constructor(
    private prisma: PrismaService,
    // PR 7 — grant/revoke are privilege changes; both persist to
    // the AuditLog (record() is best-effort and never throws).
    private audit: AuditService,
  ) {}

  // Read the role codes a user holds. Always returns an empty
  // array on lookup miss — no exception, no auth-leak.
  async getUserRoles(userId: string): Promise<OpsRole[]> {
    if (!userId) return [];
    const rows = await this.prisma.opsRoleAssignment.findMany({
      where: { userId },
      select: { role: true },
    });
    const out: OpsRole[] = [];
    for (const r of rows) {
      if (isOpsRole(r.role)) out.push(r.role);
    }
    return out;
  }

  // Bool gate used by the guard. Pure: resolves to the
  // capability map without a separate DB call for each
  // permission.
  async userHasPermission(
    userId: string,
    permission: OpsPermission,
  ): Promise<boolean> {
    const roles = await this.getUserRoles(userId);
    return hasOpsPermission(roles, permission);
  }

  // Admin grant. Idempotent (upsert on the unique (userId, role)
  // key). `granterId` is the admin executing the grant; stored
  // for the audit trail. Throws when the target doesn't exist or
  // isn't an admin — ops roles only apply on top of admin role.
  async grant(
    granterId: string,
    targetUserId: string,
    role: string,
  ): Promise<{ role: OpsRole }> {
    if (!isOpsRole(role)) {
      throw new BadRequestException('Unknown ops role');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role !== 'admin') {
      throw new BadRequestException(
        'User must be admin before assigning ops roles',
      );
    }
    await this.prisma.opsRoleAssignment.upsert({
      where: {
        userId_role: { userId: targetUserId, role },
      },
      create: {
        userId: targetUserId,
        role,
        grantedBy: granterId,
      },
      update: { grantedBy: granterId, grantedAt: new Date() },
    });
    await this.audit.record({
      actorUserId: granterId,
      actorType: 'admin',
      action: 'admin.ops_role.grant',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { role },
    });
    return { role };
  }

  // Admin revoke. Idempotent — silently no-ops when the row
  // doesn't exist so a double-click can't 404 the operator.
  // `revokerId` (PR 7) attributes the audit row; an idempotent
  // no-op revoke writes no audit entry.
  async revoke(
    revokerId: string,
    targetUserId: string,
    role: string,
  ): Promise<{ revoked: boolean }> {
    if (!isOpsRole(role)) {
      throw new BadRequestException('Unknown ops role');
    }
    const result = await this.prisma.opsRoleAssignment.deleteMany({
      where: { userId: targetUserId, role },
    });
    if (result.count > 0) {
      await this.audit.record({
        actorUserId: revokerId,
        actorType: 'admin',
        action: 'admin.ops_role.revoke',
        targetType: 'user',
        targetId: targetUserId,
        metadata: { role },
      });
    }
    return { revoked: result.count > 0 };
  }

  // Full assignment detail for the admin UI — includes
  // grantedAt + grantedBy so the operator can see who granted
  // what.
  async listAssignments(userId: string) {
    return this.prisma.opsRoleAssignment.findMany({
      where: { userId },
      orderBy: { grantedAt: 'desc' },
    });
  }
}
