import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  AuthService,
  type ForgotPasswordInput,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
} from './auth.service';
import {
  IpRateLimit,
  IpRateLimitGuard,
} from '../common/ip-rate-limit.guard';

// PR 3: per-IP ceilings on every credential-bearing route. Keyed on
// the caller's address only — never the account — so the 429 path
// leaks nothing about whether an identifier exists
// (anti-enumeration preserved). Caps are roomy for shared NATs;
// the real defences are bcrypt, the OTP attempt lockouts, and the
// anti-enumeration response shapes. These just make bulk credential
// stuffing and target-spraying expensive.
@Controller('auth')
@UseGuards(IpRateLimitGuard)
export class AuthController {
  constructor(private service: AuthService) {}

  @Post('register')
  @IpRateLimit({ bucket: 'auth-register', max: 15, windowMs: 5 * 60 * 1000 })
  register(@Body() body: RegisterInput) {
    return this.service.register(body);
  }

  @Post('login')
  @IpRateLimit({ bucket: 'auth-login', max: 20, windowMs: 5 * 60 * 1000 })
  login(@Body() body: LoginInput) {
    return this.service.login(body);
  }

  // Week 2 — Forgot Password Flow.
  // Always returns { ok: true } regardless of whether the identifier
  // matches an account (anti-enumeration); the OTP is dispatched
  // silently to the user's verified channel when applicable. See
  // AuthService.forgotPassword for the verified-channel-only
  // contract and behaviour matrix.
  @Post('forgot-password')
  @IpRateLimit({
    bucket: 'auth-forgot-password',
    max: 10,
    windowMs: 5 * 60 * 1000,
  })
  forgotPassword(@Body() body: ForgotPasswordInput) {
    return this.service.forgotPassword(body);
  }

  // Consumes the OTP from /auth/forgot-password and updates the
  // user's password hash. Single-use via OtpService.verify; F1
  // verify-attempt lockout applies. See AuthService.resetPassword
  // for the full error matrix (invalid_code / expired_code /
  // otp_locked / invalid_password).
  @Post('reset-password')
  @IpRateLimit({
    bucket: 'auth-reset-password',
    max: 15,
    windowMs: 5 * 60 * 1000,
  })
  resetPassword(@Body() body: ResetPasswordInput) {
    return this.service.resetPassword(body);
  }
}
