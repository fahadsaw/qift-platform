import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { BlocksModule } from '../blocks/blocks.module';
import { OtpModule } from '../otp/otp.module';
import { AuditModule } from '../audit/audit.module';

// Centralises UsersService construction in ONE module so every
// consumer (AppModule for the controller, OrdersModule for the
// fast-delivery check) shares the same instance.
//
// Previous setup registered UsersService in both AppModule.providers
// AND OrdersModule.providers. After the prod-foundation PR added
// `BlocksService` as a constructor dependency on UsersService, the
// duplicate registration in OrdersModule failed to resolve at
// startup — BlocksService wasn't visible inside OrdersModule's scope.
// Hoisting UsersService into its own module + exporting it is the
// canonical NestJS fix: each consumer just `imports: [UsersModule]`
// and gets the same singleton.
//
// We import BlocksModule here (which exports BlocksService) so the
// dependency graph resolves cleanly inside this module's scope.
// OtpModule + AuditModule back the OTP-verified change-phone flow
// (PR 5) — same shared singletons the auth flow uses.
@Module({
  imports: [BlocksModule, OtpModule, AuditModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
