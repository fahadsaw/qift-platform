import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy, getJwtSecret } from './jwt.strategy';
import { OtpModule } from '../otp/otp.module';
import { BetaAccessModule } from '../beta-access/beta-access.module';

// JWT secret is env-driven so production can rotate per environment.
// Local dev keeps the historical literal as a fallback so a fresh
// checkout boots without setting any env. Auth logic (sign / verify
// flow) is unchanged — only the secret SOURCE moved from a literal
// into `getJwtSecret()`.
//
// Week 2 (Forgot Password Flow) — OtpModule is imported so
// AuthService can reuse OtpService.send / OtpService.verify for the
// forgot-password / reset-password endpoints. No duplicate OTP
// infrastructure; F1 lockout + send rate-limit + single-use semantics
// all inherited automatically.
@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: { expiresIn: '7d' },
    }),
    OtpModule,
    // Closed Beta Gate — AuthService.register consults
    // BetaAccessService.decideRegistration before admitting a new
    // account. Existing-user logins are NOT gated (the check runs only
    // on the new-user branch).
    BetaAccessModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
