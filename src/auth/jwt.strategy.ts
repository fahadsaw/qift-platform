import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

// Single source of truth for the JWT signing secret. Sign (AuthModule)
// and verify (this strategy) MUST use the same value, so we route both
// through here.
//
// FAIL-SAFE CONTRACT
//   - JWT_SECRET set (non-blank)        → use it, any environment.
//   - missing + NODE_ENV === 'production' → THROW. Both call sites run
//     at module init (JwtModule.register + the strategy constructor),
//     so the throw aborts boot — a production deploy can never come up
//     signing tokens with the publicly-known dev literal, which would
//     make every account forgeable. Railway sets NODE_ENV=production
//     by default, so the guard fires on our deploy target.
//   - missing + anything else            → historical dev fallback, so
//     a fresh checkout still boots with zero configuration. A loud
//     warn (suppressed under jest) makes the fallback visible in dev
//     logs in case a misconfigured staging box ever runs without
//     NODE_ENV.
//
// Rotating the secret invalidates every issued token — expected
// behaviour for a security boundary.
export function getJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set — refusing to boot in production. ' +
        'The development fallback secret is public (it lives in this ' +
        'repo), so booting with it would make every session token ' +
        'forgeable. Set JWT_SECRET to a long random string (e.g. ' +
        '`openssl rand -base64 48`) in the environment and redeploy.',
    );
  }

  if (process.env.NODE_ENV !== 'test') {
    new Logger('JwtSecret').warn(
      'JWT_SECRET is not set — using the insecure development fallback. ' +
        'Fine for local dev; never for anything internet-facing.',
    );
  }
  return 'qift-secret';
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
