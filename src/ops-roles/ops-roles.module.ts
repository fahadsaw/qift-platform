import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpsRolesService } from './ops-roles.service';
import { OpsRoleGuard } from './ops-role.guard';

// Re-usable RBAC module. Exposes the service (for direct
// programmatic permission checks) and the guard (for
// declarative `@RequireOpsPermission(...)` decoration).
// PrismaService is registered locally because the codebase
// doesn't run a global PrismaModule — modules inject it
// directly the same way AdminModule does.
@Module({
  providers: [OpsRolesService, OpsRoleGuard, PrismaService],
  exports: [OpsRolesService, OpsRoleGuard],
})
export class OpsRolesModule {}
