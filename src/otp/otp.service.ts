import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter } from '../common/rate-limiter';

// Per-phone OTP rate limit: 5 sends per 5 minutes. Stops obvious SMS
// pumping / harassment without burdening normal usage (a typical user
// hits send once or twice per session). Process-local; under multi-
// replica deployment the effective ceiling is N×5 — acceptable for
// the demo. See common/rate-limiter.ts for the implementation note.
const otpSendLimiter = new RateLimiter(5, 5 * 60 * 1000);

export type OtpType = 'phone' | 'email';

export type SendOtpInput = { target?: string; type?: OtpType };
export type VerifyOtpInput = { target?: string; code?: string };

const CODE_LENGTH = 4;
const TTL_MINUTES = 5;

// ─────────────────────────────────────────────────────────────────────
// TEMPORARY: OTP dev-mode fallback.
//
// Until commercial SMS (Taqnyat) is wired up + verified, the OTP
// pipeline runs in "dev mode": we still generate the code, persist it
// in the Otp table, and let the existing verify() path succeed — but
// we skip the network call entirely and surface the code as a big
// banner in the server logs instead.
//
// Three independent triggers, ANY of which puts us in dev mode:
//   1. OTP_DEV_MODE=1 / true / yes      → explicit override
//   2. NODE_ENV !== 'production'        → local + most CI envs
//   3. TAQNYAT_BEARER_TOKEN missing     → also `'disabled'` / `'dev'`
//      (case-insensitive) so ops can keep the env var present but off
//
// To run with REAL SMS: set NODE_ENV=production AND a real bearer
// token AND leave OTP_DEV_MODE unset. Removing this helper is the
// graduation step — see `send()` for the integration point.
// ─────────────────────────────────────────────────────────────────────
function resolveOtpMode(): { dev: boolean; reason: string } {
  const explicit = process.env.OTP_DEV_MODE?.trim().toLowerCase();
  if (explicit === '1' || explicit === 'true' || explicit === 'yes') {
    return { dev: true, reason: 'OTP_DEV_MODE=on' };
  }
  if (process.env.NODE_ENV !== 'production') {
    return {
      dev: true,
      reason: `NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}`,
    };
  }
  const token = process.env.TAQNYAT_BEARER_TOKEN?.trim().toLowerCase();
  if (!token || token === 'disabled' || token === 'dev') {
    return { dev: true, reason: 'TAQNYAT_BEARER_TOKEN missing/disabled' };
  }
  return { dev: false, reason: 'production+taqnyat' };
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger('Otp');

  constructor(private prisma: PrismaService) {}

  async send(body: SendOtpInput) {
    const target = body.target?.trim();
    const type = body.type === 'email' ? 'email' : 'phone';

    if (!target) {
      throw new BadRequestException('target is required');
    }

    // Rate limit BEFORE writing the row. Returns 429 with a stable code
    // so the frontend can render a friendly "you've requested too many
    // codes — try again in a few minutes" message without parsing
    // localized strings.
    if (!otpSendLimiter.hit(`otp:${target}`)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'otp_rate_limited',
          message: 'Too many OTP requests — please wait a few minutes',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // ── TEMPORARY (private testing) ─────────────────────────────────
    // When OTP_DEV_MODE is explicitly on, pin the code to 1234 so
    // testers don't have to dig through Railway logs to find a
    // random 4-digit code. The Otp row is still inserted into the
    // DB, verify() still runs the same expiry + single-use checks,
    // and `resolveOtpMode()` below still routes us into the
    // dev-banner branch (skipping Taqnyat). Production behaviour is
    // unchanged — when OTP_DEV_MODE is unset (and a real Taqnyat
    // token is present), the random code generation path runs as
    // before.
    //
    // Remove this block (and the OTP_DEV_MODE env var) before the
    // public launch.
    const isFixedCodeMode = ['1', 'true', 'yes'].includes(
      process.env.OTP_DEV_MODE?.trim().toLowerCase() ?? '',
    );
    const code = isFixedCodeMode ? '1234' : this.generateCode();
    // ────────────────────────────────────────────────────────────────

    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

    // Persist FIRST so the auth flow can verify against the row even if
    // SMS delivery is slow or fails. AuthService.register and
    // OtpService.verify both read from the same Otp table.
    await this.prisma.otp.create({
      data: { target, code, type, expiresAt },
    });

    const mode = resolveOtpMode();
    if (mode.dev) {
      // Big banner so the OTP is impossible to miss when scrolling
      // Railway / pm2 / docker logs. Nest logger AT WARN level so the
      // line isn't filtered out by typical "info+" log rules. Plain
      // console.log too because some log shippers grab stdout but not
      // the structured logger output.
      const banner = '═══════════════════════════════════════════════';
      this.logger.warn(banner);
      this.logger.warn(`🔐  DEV OTP for ${target} = ${code}`);
      this.logger.warn(
        `    type=${type}  reason=${mode.reason}  expires=${expiresAt.toISOString()}`,
      );
      this.logger.warn(banner);
      console.log(`DEV OTP for ${target} = ${code}`);
      // Return success — no SMS attempted, no error thrown. The
      // /otp/send response shape is unchanged so the frontend has
      // nothing to adapt.
      return { ok: true, expiresAt };
    }

    // Production + real Taqnyat token. Compact log of the code so ops
    // can debug a delivery complaint against a real user. No banner
    // here — keeps prod logs grep-able.
    this.logger.log(`OTP for ${type} ${target}: ${code}`);
    console.log('OTP:', code);

    // Out-of-band delivery. Failure is non-fatal — the row is already
    // persisted; the user can still receive the code via SMS retry.
    if (type === 'phone') {
      await this.sendSmsViaTaqnyat(target, `رمز التحقق الخاص بك هو: ${code}`);
    }

    return { ok: true, expiresAt };
  }

  // Taqnyat is the SMS provider used in production. The bearer token
  // lives in TAQNYAT_BEARER_TOKEN.
  //
  // This helper is now only reached when `resolveOtpMode()` returned
  // `dev: false` — i.e. NODE_ENV=production AND a real token AND
  // OTP_DEV_MODE unset. The token-missing branch below is defensive
  // (in case a future caller invokes this helper directly) but should
  // never fire on the normal /otp/send path.
  //
  // Errors are SWALLOWED — the OTP row is already persisted and the
  // /otp/send response is already on its way back. Failing here would
  // strand the user with no way to receive the code.
  private async sendSmsViaTaqnyat(target: string, message: string) {
    if (!target) {
      // Defensive — `send()` already validated, but keeps the helper
      // safe if ever called from elsewhere.
      this.logger.error('SMS Error: target is missing');
      return;
    }

    const token = process.env.TAQNYAT_BEARER_TOKEN;
    if (!token) {
      this.logger.warn(
        'TAQNYAT_BEARER_TOKEN not set — skipping SMS (defensive path)',
      );
      return;
    }

    try {
      const res = await fetch('https://api.taqnyat.sa/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          recipients: [target.replace('+', '')],
          body: message,
          sender: process.env.TAQNYAT_SENDER ?? 'QIFT',
        }),
      });
      const data: unknown = await res.json();
      this.logger.log(`Taqnyat status: ${res.status}`);
      this.logger.log(`Taqnyat response: ${JSON.stringify(data)}`);
      // Non-2xx is a soft failure. We don't throw — the user can still
      // verify if they received the SMS through any other path — but
      // we surface it explicitly so prod alerts can grep for it.
      if (!res.ok) {
        this.logger.error(
          `Taqnyat non-2xx (${res.status}) — SMS delivery may have failed`,
        );
      }
    } catch (error) {
      this.logger.error(`SMS Error: ${String(error)}`);
    }
  }

  async verify(body: VerifyOtpInput) {
    const target = body.target?.trim();
    const code = body.code?.trim();

    if (!target || !code) {
      throw new BadRequestException('target and code are required');
    }

    const otp = await this.prisma.otp.findFirst({
      where: { target },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.code !== code) {
      throw new BadRequestException('invalid_code');
    }
    if (otp.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('expired_code');
    }

    // Single-use: best-effort delete so the code can't be replayed.
    await this.prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});

    return { ok: true };
  }

  private generateCode(): string {
    const max = 10 ** CODE_LENGTH;
    const min = 10 ** (CODE_LENGTH - 1);
    const n = Math.floor(min + Math.random() * (max - min));
    return String(n);
  }
}
