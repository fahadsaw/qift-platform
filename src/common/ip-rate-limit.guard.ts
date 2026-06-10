// Per-IP rate limiting for auth-sensitive endpoints (PR 3, platform
// stabilization).
//
// WHY PER-IP, ON TOP OF THE EXISTING PER-TARGET LIMITS
// The OTP send path already caps 5 sends / 5 min per *target*, and
// verify has per-row + per-target attempt lockouts. None of those
// stop one machine from spraying MANY targets (target enumeration,
// SMS cost pumping, password stuffing across accounts). A per-IP
// ceiling bounds that whole class without touching any per-account
// semantics — and because the key is the caller's address, not the
// account, it leaks nothing about whether a target exists
// (anti-enumeration preserved).
//
// MECHANICS
// Reuses the house RateLimiter (sliding window, in-memory). Same
// caveat as every other use of it: per-process state, so N replicas
// → N× the effective ceiling. Acceptable at closed-beta scale (the
// documented house position in common/rate-limiter.ts); the
// DB-backed per-target lockout in OtpService is the replica-safe
// layer underneath.
//
// `req.ip` is the real client address because main.ts sets
// `trust proxy` (Railway terminates TLS in front of us). A client
// can't spoof X-Forwarded-For past the Railway edge.
//
// USAGE
//   @UseGuards(IpRateLimitGuard)
//   @IpRateLimit({ bucket: 'auth-login', max: 20, windowMs: 5 * 60_000 })
//   @Post('login') ...
//
// Routes without the decorator pass through untouched. On limit the
// guard throws 429 with the same stable-code envelope the OTP send
// limiter uses, so frontends can branch on `code` without parsing
// prose.

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimiter } from './rate-limiter';

export type IpRateLimitConfig = {
  // Stable bucket name — also the limiter-map key, so two routes
  // sharing a bucket share a budget (intentional for symmetric
  // pairs like forgot/reset if ever desired; today each route has
  // its own bucket).
  bucket: string;
  max: number;
  windowMs: number;
};

export const IP_RATE_LIMIT_KEY = 'ip_rate_limit_config';

export const IpRateLimit = (config: IpRateLimitConfig) =>
  SetMetadata(IP_RATE_LIMIT_KEY, config);

@Injectable()
export class IpRateLimitGuard implements CanActivate {
  // Static so every guard instance (Nest may construct one per
  // consuming module) shares the same window state per bucket.
  private static limiters = new Map<string, RateLimiter>();

  // Tests need clean windows; production never calls this.
  static resetForTests(): void {
    IpRateLimitGuard.limiters.clear();
  }

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const config = this.reflector.get<IpRateLimitConfig | undefined>(
      IP_RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!config) return true;

    const req = context.switchToHttp().getRequest<{ ip?: string }>();
    // 'unknown' bucket-shares clients with no resolvable address —
    // strictly safer than letting them bypass the limit.
    const ip = req.ip?.trim() || 'unknown';

    let limiter = IpRateLimitGuard.limiters.get(config.bucket);
    if (!limiter) {
      limiter = new RateLimiter(config.max, config.windowMs);
      IpRateLimitGuard.limiters.set(config.bucket, limiter);
    }

    if (!limiter.hit(`${config.bucket}:${ip}`)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'rate_limited',
          message: 'Too many requests — please wait a few minutes',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
