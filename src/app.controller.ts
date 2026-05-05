import { Controller, Get } from '@nestjs/common';

// Root controller. The OTP send/verify routes that previously lived here
// alongside an in-memory otpStore + an inline Taqnyat sendSms have been
// removed — that path duplicated OtpController and shadowed it at runtime.
// All OTP traffic now flows through OtpModule (apps/api/src/otp/), which
// persists to the Prisma `Otp` table and is the same source of truth that
// AuthService.register reads from.
@Controller()
export class AppController {
  @Get()
  getHello() {
    return { message: 'API is running' };
  }
}
