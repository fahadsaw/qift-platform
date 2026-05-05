import { Module } from '@nestjs/common';
import { SocialAccountsController } from './social-accounts.controller';
import { SocialAccountsService } from './social-accounts.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [SocialAccountsController],
  providers: [SocialAccountsService, PrismaService],
  exports: [SocialAccountsService],
})
export class SocialAccountsModule {}
