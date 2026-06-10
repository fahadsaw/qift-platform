import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  OtpService,
  type SendOtpInput,
  type VerifyOtpInput,
} from './otp.service';
import {
  IpRateLimit,
  IpRateLimitGuard,
} from '../common/ip-rate-limit.guard';

// Public — these endpoints run during register/login before any JWT exists.
//
// PR 3: per-IP ceilings on top of the service-level per-target
// limits. The per-target limits stop hammering ONE phone/email; the
// per-IP ceilings stop one machine from spraying MANY targets (SMS
// cost pumping, enumeration sweeps). Caps are deliberately roomy —
// a family on one NAT shouldn't feel them — because the real
// brute-force defence is the 6-digit space + attempt lockouts in
// OtpService, not these.
@Controller('otp')
@UseGuards(IpRateLimitGuard)
export class OtpController {
  constructor(private service: OtpService) {}

  @Post('send')
  @IpRateLimit({ bucket: 'otp-send', max: 15, windowMs: 5 * 60 * 1000 })
  send(@Body() body: SendOtpInput) {
    return this.service.send(body);
  }

  @Post('verify')
  @IpRateLimit({ bucket: 'otp-verify', max: 30, windowMs: 5 * 60 * 1000 })
  verify(@Body() body: VerifyOtpInput) {
    return this.service.verify(body);
  }
}
