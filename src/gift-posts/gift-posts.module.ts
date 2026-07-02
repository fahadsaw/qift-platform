import { Module } from '@nestjs/common';
import { GiftPostsController } from './gift-posts.controller';
import { GiftPostsService } from './gift-posts.service';
import { NotificationsModule } from '../notifications/notifications.module';

// Imports NotificationsModule (not provided directly) so the
// appreciation-notification path in GiftPostsService reuses the
// AppModule's NotificationsService instance — keeps push provider
// state + token caches consistent across the app.
@Module({
  imports: [NotificationsModule],
  controllers: [GiftPostsController],
  providers: [GiftPostsService],
  exports: [GiftPostsService],
})
export class GiftPostsModule {}
