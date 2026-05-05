import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy, getJwtSecret } from './jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';

// JWT secret is env-driven so production can rotate per environment.
// Local dev keeps the historical literal as a fallback so a fresh
// checkout boots without setting any env. Auth logic (sign / verify
// flow) is unchanged — only the secret SOURCE moved from a literal
// into `getJwtSecret()`.
@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PrismaService],
})
export class AuthModule {}
