import { Controller, Get } from '@nestjs/common';

// Root controller. The OTP send/verify routes that previously lived here
// alongside an in-memory otpStore + an inline Taqnyat sendSms have been
// removed — that path duplicated OtpController and shadowed it at runtime.
// All OTP traffic now flows through OtpModule (apps/api/src/otp/), which
// persists to the Prisma `Otp` table and is the same source of truth that
// AuthService.register reads from.
@Controller()
export class AppController {
  @Get()
  getHello() {
    return { message: 'API is running' };
  }

  // Dedicated healthcheck endpoint. Railway / Render / Fly all support
  // wiring an HTTP healthcheck path that gates traffic-routing on a 2xx
  // response — point them at GET /health.
  //
  // Intentionally cheap: no DB call, no auth, no external lookup. The
  // healthcheck signals "the Node process bound the port and Nest is
  // ready" — that's what Railway's TCP-based default check would tell
  // it anyway. We add timestamp + uptime so the operator can spot a
  // stuck process from log diffing.
  //
  // We do NOT touch Prisma here. A DB outage shouldn't take the API
  // out of rotation if all it can serve is a status page; the schema-
  // dependent routes will fail individually with their own errors.
  @Get('health')
  getHealth() {
    // Deployed-commit SHA. Railway exposes RAILWAY_GIT_COMMIT_SHA on
    // every build; other hosts use different envs (RENDER_GIT_COMMIT,
    // VERCEL_GIT_COMMIT_SHA, FLY_REVISION). Read all of them and
    // surface the first that's set so /health doubles as a "what
    // version is running" answer without needing platform access.
    //
    // Returning the FULL sha (40 chars) and a 7-char short form so
    // the operator can git-log against either. Falls back to
    // 'unknown' when none of the platform vars are populated (e.g.
    // local dev). No secrets surfaced; all listed envs are
    // public commit hashes.
    const sha =
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.FLY_REVISION ||
      process.env.GIT_COMMIT ||
      '';
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      commit: sha || 'unknown',
      commitShort: sha ? sha.slice(0, 7) : 'unknown',
      // Numeric build epoch baked at boot. Lets the operator tell
      // a re-deploy from a long-running process even if the SHA
      // happens to be unchanged (rebuild without commit).
      bootedAt: BOOTED_AT,
    };
  }
}

// Captured once on module load; survives the Node process's
// lifetime. Intentionally module-scoped (not @Get-scoped) so two
// /health hits from different machines see the same value and a
// rolling restart shows up as a bootedAt jump.
const BOOTED_AT = new Date().toISOString();
