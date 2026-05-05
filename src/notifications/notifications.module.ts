import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PushModule } from '../push/push.module';

// Exported so GiftsModule (and any future producer) can inject the service
// to fire notifications without going through the HTTP layer. We import
// PushModule so NotificationsService.trigger can fan out an in-app
// notification to the user's registered web-push subscriptions in the
// same call.
@Module({
  imports: [PushModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PrismaService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
