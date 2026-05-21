import { Controller, Post, Body } from '@nestjs/common';
import {
  AuthService,
  type ForgotPasswordInput,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
} from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private service: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterInput) {
    return this.service.register(body);
  }

  @Post('login')
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
  forgotPassword(@Body() body: ForgotPasswordInput) {
    return this.service.forgotPassword(body);
  }

  // Consumes the OTP from /auth/forgot-password and updates the
  // user's password hash. Single-use via OtpService.verify; F1
  // verify-attempt lockout applies. See AuthService.resetPassword
  // for the full error matrix (invalid_code / expired_code /
  // otp_locked / invalid_password).
  @Post('reset-password')
  resetPassword(@Body() body: ResetPasswordInput) {
    return this.service.resetPassword(body);
  }
}
