import { Module } from '@nestjs/common';
import { AddressesController } from './addresses.controller';
import { AddressesService } from './addresses.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';

// AddressesService notifies pending senders ("address ready for retry")
// when a user transitions from no-default to has-default. That requires
// NotificationsService — pulled in via NotificationsModule (which itself
// includes Push fan-out, so the in-app row + push hit fire together).
@Module({
  imports: [NotificationsModule],
  controllers: [AddressesController],
  providers: [AddressesService, PrismaService],
})
export class AddressesModule {}
