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

  // Dedicated healthcheck endpoint. Railway / Render / Fly all support
  // wiring an HTTP healthcheck path that gates traffic-routing on a 2xx
  // response — point them at GET /health.
  //
  // Intentionally cheap: no DB call, no auth, no external lookup. The
  // healthcheck signals "the Node process bound the port and Nest is
  // ready" — that's what Railway's TCP-based default check would tell
  // it anyway. We add timestamp + uptime so the operator can spot a
  // stuck process from log diffing.
  //
  // We do NOT touch Prisma here. A DB outage shouldn't take the API
  // out of rotation if all it can serve is a status page; the schema-
  // dependent routes will fail individually with their own errors.
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
