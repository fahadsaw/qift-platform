import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StoresModule } from '../stores/stores.module';

// AdminModule. Pulls StoresModule for the v2 review endpoints
// (storeDetail / reviewStore reuse the same canonical projection
// + transition rules the owner-side endpoints use). The guard reads
// User.role directly from the DB on every request so it can't go
// stale relative to the JWT.
@Module({
  imports: [StoresModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, PrismaService],
})
export class AdminModule {}
