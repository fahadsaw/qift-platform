import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IpRateLimit, IpRateLimitGuard } from '../common/ip-rate-limit.guard';
import { ClaimService } from './claim.service';
import type { ClaimAddressInput } from './claim.service';

// /claim/* — the PUBLIC account-less claim surface (Corporate
// Foundation PR 5). No JwtAuthGuard anywhere: the recipient has no
// account and never will. Identity = token possession + OTP to the
// bound channel; authorization beyond that is the short-lived claim
// session minted at verify-otp.
//
// Every route is IP-rate-limited (the token space is unguessable —
// 256-bit — but rate limits keep enumeration noise and OTP abuse
// bounded anyway).
@Controller('claim')
@UseGuards(IpRateLimitGuard)
export class ClaimController {
  constructor(private readonly claims: ClaimService) {}

  // Step 1 — generic teaser. F1: the response carries NO recipient
  // name, NO org name, NO gift. Just "something is waiting" + a
  // masked channel hint.
  @Get(':token')
  @IpRateLimit({ bucket: 'claim-teaser', max: 30, windowMs: 5 * 60_000 })
  teaser(@Param('token') token: string) {
    return this.claims.teaser(token);
  }

  // Step 2 — OTP to the bound channel. The recipient never types a
  // target; OtpService's own per-target limits stack on top of this
  // IP bucket.
  @Post(':token/send-otp')
  @IpRateLimit({ bucket: 'claim-otp-send', max: 5, windowMs: 10 * 60_000 })
  sendOtp(@Param('token') token: string) {
    return this.claims.sendOtp(token);
  }

  // Step 3 — possession proof. Success returns the claim session +
  // the FIRST identifying payload (identity echo + gift reveal).
  @Post(':token/verify-otp')
  @IpRateLimit({ bucket: 'claim-otp-verify', max: 10, windowMs: 10 * 60_000 })
  verifyOtp(
    @Param('token') token: string,
    @Body() body: { code?: string },
  ) {
    return this.claims.verifyOtp(token, body?.code);
  }

  // Post-OTP re-read (page refresh).
  @Post(':token/reveal')
  @IpRateLimit({ bucket: 'claim-reveal', max: 30, windowMs: 5 * 60_000 })
  reveal(
    @Param('token') token: string,
    @Body() body: { sessionToken?: string },
  ) {
    return this.claims.reveal(token, body?.sessionToken);
  }

  // "This isn't me" — the identity echo's escape hatch.
  @Post(':token/not-me')
  @IpRateLimit({ bucket: 'claim-finalize', max: 10, windowMs: 10 * 60_000 })
  notMe(
    @Param('token') token: string,
    @Body() body: { sessionToken?: string },
  ) {
    return this.claims.notMe(token, body?.sessionToken);
  }

  @Post(':token/decline')
  @IpRateLimit({ bucket: 'claim-finalize', max: 10, windowMs: 10 * 60_000 })
  decline(
    @Param('token') token: string,
    @Body() body: { sessionToken?: string },
  ) {
    return this.claims.decline(token, body?.sessionToken);
  }

  // Step 4 — coverage-checked address; claimed is irrevocable. The
  // address is write-only: no API anywhere returns it.
  @Post(':token/address')
  @IpRateLimit({ bucket: 'claim-address', max: 10, windowMs: 10 * 60_000 })
  submitAddress(
    @Param('token') token: string,
    @Body() body: { sessionToken?: string } & ClaimAddressInput,
  ) {
    const { sessionToken, ...address } = body ?? {};
    return this.claims.submitAddress(token, sessionToken, address);
  }
}
