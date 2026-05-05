import { Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PrismaService } from '../prisma/prisma.service';

// Exported so NotificationsModule (and any future producer that wants to
// fan out a push without going through the in-app notifications table)
// can inject PushService directly.
@Module({
  controllers: [PushController],
  providers: [PushService, PrismaService],
  exports: [PushService],
})
export class PushModule {}
