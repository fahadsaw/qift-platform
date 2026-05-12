import { Module } from '@nestjs/common';
import { GiftPostsController } from './gift-posts.controller';
import { GiftPostsService } from './gift-posts.service';
import { PrismaService } from '../prisma/prisma.service';

// V1 surface — see gift-posts.service.ts for what's in scope.
// Module is self-contained: no NotificationsModule dependency yet
// (no publish-time notification fires in V1; the future receiver-
// side surface will introduce one).
@Module({
  controllers: [GiftPostsController],
  providers: [GiftPostsService, PrismaService],
  exports: [GiftPostsService],
})
export class GiftPostsModule {}
