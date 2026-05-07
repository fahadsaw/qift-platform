import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
    // trail entries.
    if (!user || user.deletedAt) {
      throw new ForbiddenException('Admin access required');
    }
    if (user.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
