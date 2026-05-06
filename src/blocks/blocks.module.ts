import { Module } from '@nestjs/common';
import { BlocksController } from './blocks.controller';
import { BlocksService } from './blocks.service';
import { PrismaService } from '../prisma/prisma.service';

// `BlocksService` is exported so UsersService.searchUsers can consume
// `listExcludedIds(viewerId)` to filter blocked users out of search
// results in both directions.
@Module({
  controllers: [BlocksController],
  providers: [BlocksService, PrismaService],
  exports: [BlocksService],
})
export class BlocksModule {}
