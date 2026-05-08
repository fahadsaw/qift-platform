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

  // Passport calls this after a JWT signature passes. The shape of
  // `payload` is whatever AuthService.signToken() encoded, narrowed
  // here so the rest of the codebase reads `req.user` as a typed
  // record. `validate()` is sync but Passport's typings require
  // returning a Promise — wrapping the literal in Promise.resolve
  // satisfies both without forcing an unused `await`.
  validate(
    payload: unknown,
  ): Promise<{ userId: string; qiftUsername: string }> {
    const p =
      typeof payload === 'object' && payload !== null
        ? (payload as { sub?: unknown; qiftUsername?: unknown })
        : {};
    return Promise.resolve({
      userId: typeof p.sub === 'string' ? p.sub : '',
      qiftUsername: typeof p.qiftUsername === 'string' ? p.qiftUsername : '',
    });
  }
}
