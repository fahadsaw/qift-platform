import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

// Single source of truth for the JWT signing secret. Sign (AuthModule)
// and verify (this strategy) MUST use the same value, so we route both
// through here. Reads JWT_SECRET from env; falls back to the historical
// literal so local dev keeps working without configuration. In
// production, JWT_SECRET MUST be set to a long random string —
// rotating it invalidates every issued token, which is the expected
// behaviour for a security boundary.
export function getJwtSecret(): string {
  return process.env.JWT_SECRET?.trim() || 'qift-secret';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
  }

  async validate(payload: any) {
    return {
      userId: payload.sub,
      qiftUsername: payload.qiftUsername,
    };
  }
}
