import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OpsRolesService } from './ops-roles.service';
import { OpsRoleGuard } from './ops-role.guard';

// Re-usable RBAC module. Exposes the service (for direct
// programmatic permission checks) and the guard (for
// declarative `@RequireOpsPermission(...)` decoration).
// PrismaService is injected from the global PrismaModule.
// AuditModule (PR 7): grant/revoke persist to the AuditLog.
@Module({
  imports: [AuditModule],
  providers: [OpsRolesService, OpsRoleGuard],
  exports: [OpsRolesService, OpsRoleGuard],
})
export class OpsRolesModule {}
