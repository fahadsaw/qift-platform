import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';

// AdminModule. Self-contained — depends on nothing but Prisma. The
// guard reads User.role directly from the DB on every request so it
// can't go stale relative to the JWT.
@Module({
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, PrismaService],
})
export class AdminModule {}
