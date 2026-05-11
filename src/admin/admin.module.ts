import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StoresModule } from '../stores/stores.module';
import { OpsRolesModule } from '../ops-roles/ops-roles.module';

// AdminModule. Pulls StoresModule for the v2 review endpoints
// (storeDetail / reviewStore reuse the same canonical projection
// + transition rules the owner-side endpoints use). OpsRolesModule
// provides the granular permission layer that gates writes within
// the admin surface (PATCH plan / featured / status / ops-role
// assignment) on top of the coarse AdminGuard.
@Module({
  imports: [StoresModule, OpsRolesModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, PrismaService],
})
export class AdminModule {}
