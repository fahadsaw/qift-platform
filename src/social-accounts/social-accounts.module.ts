import { Module } from '@nestjs/common';
import { SocialAccountsController } from './social-accounts.controller';
import { SocialAccountsService } from './social-accounts.service';

@Module({
  controllers: [SocialAccountsController],
  providers: [SocialAccountsService],
  exports: [SocialAccountsService],
})
export class SocialAccountsModule {}
