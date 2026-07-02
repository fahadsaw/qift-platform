import { Module } from '@nestjs/common';
import { FollowsController, UserFollowsController } from './follows.controller';
import { FollowsService } from './follows.service';
import { BlocksModule } from '../blocks/blocks.module';

@Module({
  imports: [BlocksModule],
  controllers: [FollowsController, UserFollowsController],
  providers: [FollowsService],
})
export class FollowsModule {}
