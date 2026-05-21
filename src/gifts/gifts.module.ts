import { Module } from '@nestjs/common';
import { GiftsController } from './gifts.controller';
import { GiftsService } from './gifts.service';
import { GiftsAutoDefaultService } from './gifts-auto-default.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksModule } from '../blocks/blocks.module';
import { NotificationsModule } from '../notifications/notifications.module';

// We import NotificationsModule (rather than adding the service to the
// providers list) so we share the AppModule instance and don't risk two
// services racing on the same Prisma client.
//
// Week 1 security hardening (F3) — BlocksModule is imported so
// GiftsService can call BlocksService.isBlockedEitherWay before
// creating a gift. Every other social surface (profile, search,
// follow, gift-post view) already consults BlocksService; gift
// creation was the lone bypass.
@Module({
  imports: [BlocksModule, NotificationsModule],
  controllers: [GiftsController],
  providers: [GiftsService, GiftsAutoDefaultService, PrismaService],
  exports: [GiftsService],
})
export class GiftsModule {}
