import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { arePermissionChecksEnabled, hasPermission } from '../rbac';

// Guards every /admin/* route. JwtAuthGuard runs first (controller-
// level @UseGuards order matters) so `req.user.userId` is populated;
// this guard then re-loads the user's `role` from the DB and refuses
// anyone who isn't `'admin'`.
//
// We deliberately DO NOT trust the JWT payload for the role:
//   - JWTs persist for weeks. A token issued before promotion would
//     not see the new role; a token issued before demotion would
//     keep the old one.
//   - The role lookup is a single indexed point query on a tiny
//     User row, so the per-request cost is negligible.
//
// First-admin bootstrap: there's no user-facing way to GRANT the
// admin role (the PATCH /admin/users/:id/role endpoint requires
// admin to begin with). The very first admin must be promoted with
// a one-shot SQL update against the production DB:
//   UPDATE "User" SET role = 'admin' WHERE id = '<seed-user-id>';
// After that, an existing admin can promote the rest from the
// dashboard.
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();
    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('Admin access required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, deletedAt: true },
    });
    // Soft-deleted accounts (even if they once had admin) are blocked
    // — admin actions on a "deleted" account would be confusing audit
    // trail entries. This rejection stays OUTSIDE the RBAC dispatch
    // below: soft-deleted users are blocked regardless of flag state
    // and regardless of which roles the catalog says they hold.
    if (!user || user.deletedAt) {
      throw new ForbiddenException('Admin access required');
    }
    // FIRST RBAC GUARD MIGRATION (PR B-4).
    // Kill-switch protected via arePermissionChecksEnabled() from
    // src/rbac/permission-checks-flag.ts:
    //   - flag OFF (default in prod) → legacy `user.role === 'admin'`
    //   - flag ON  (default in dev/test) → hasPermission(user,
    //       'admin.access')
    // Both branches resolve to the same boolean for every current
    // account, because legacy_admin (the RBAC role every
    // user.role === 'admin' account maps to via legacyRoleFor) holds
    // admin.access. The throw and exception message are identical in
    // both branches — callers see no behaviour difference. The flag
    // can be flipped back instantly via env var if anything drifts.
    const authorized = arePermissionChecksEnabled()
      ? hasPermission(user, 'admin.access')
      : user.role === 'admin';
    if (!authorized) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
