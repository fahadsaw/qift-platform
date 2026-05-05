import { Module } from '@nestjs/common';
import { GiftsController } from './gifts.controller';
import { GiftsService } from './gifts.service';
import { GiftsAutoDefaultService } from './gifts-auto-default.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';

// We import NotificationsModule (rather than adding the service to the
// providers list) so we share the AppModule instance and don't risk two
// services racing on the same Prisma client.
@Module({
  imports: [NotificationsModule],
  controllers: [GiftsController],
  providers: [GiftsService, GiftsAutoDefaultService, PrismaService],
  exports: [GiftsService],
})
export class GiftsModule {}
