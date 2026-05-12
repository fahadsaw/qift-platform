import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Guard for routes that work for BOTH authenticated and anonymous
// callers — the route handler reads `req.user` when present, treats
// it as null when absent.
//
// Concretely: the same passport-jwt strategy runs, but a missing /
// invalid Bearer token does NOT throw 401. We just leave `req.user`
// undefined and let the handler decide.
//
// Used by the public read endpoints on `/gift-posts/by-slug/:slug`
// and `/gift-posts/by-user/:userId` so /p/<slug> share links work
// for users who don't have a Qift account yet (the share URL is the
// pre-login funnel).
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Tell Nest the guard always lets the request through.
  canActivate(context: ExecutionContext) {
    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  // Passport calls this after the strategy runs. When `err` or
  // `info` is set (missing token, invalid token, expired token),
  // we swallow it and return `undefined` so `req.user` stays
  // undefined instead of throwing 401. When `user` IS resolved,
  // we return it — same shape as JwtAuthGuard.
  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser | undefined {
    if (err || !user) return undefined;
    return user;
  }
}
