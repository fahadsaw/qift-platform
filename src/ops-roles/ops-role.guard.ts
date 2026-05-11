import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OpsRolesService } from './ops-roles.service';
import type { OpsPermission } from './ops-roles';

// Route metadata key — set via the @RequireOpsPermission()
// decorator on controllers / handlers. The guard reads the
// metadata to know which permission this route requires; absent
// metadata means "no ops-permission requirement" and the guard
// no-ops.
const META_KEY = 'qift:opsPermission';

export const RequireOpsPermission = (permission: OpsPermission) =>
  SetMetadata(META_KEY, permission);

// Stacks on top of JwtAuthGuard + AdminGuard. By the time
// this guard runs, req.user is populated and the user is an
// admin. The guard then checks that the user holds an ops
// role whose capability map includes the required permission.
//
// Used additively — controllers that don't carry the decorator
// behave exactly as before (AdminGuard alone). New surfaces
// gradually adopt the decorator without a coordinated rewrite.
@Injectable()
export class OpsRoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private opsRoles: OpsRolesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      OpsPermission | undefined
    >(META_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<{
      user?: { userId: string };
    }>();
    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('Missing user context');
    }
    const ok = await this.opsRoles.userHasPermission(userId, required);
    if (!ok) {
      throw new ForbiddenException('Operation requires elevated permissions');
    }
    return true;
  }
}
