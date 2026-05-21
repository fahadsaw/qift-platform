import { Module } from '@nestjs/common';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';

// Week 2 (Forgot Password Flow) — OtpService is now exported so
// AuthService can reuse the existing send/verify primitives for
// password-recovery flows without duplicating the OTP infrastructure.
// The /otp/* controller surface is unchanged; this only widens the
// DI exposure.
@Module({
  controllers: [OtpController],
  providers: [OtpService, PrismaService],
  exports: [OtpService],
})
export class OtpModule {}
