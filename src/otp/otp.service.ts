import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter } from '../common/rate-limiter';
import { MailService } from '../mail/mail.service';
import { normalizePhone } from '../auth/phone-normalize';

// Per-target OTP rate limit: 5 sends per 5 minutes. Stops obvious SMS
// pumping / harassment without burdening normal usage. Process-local;
// under multi-replica deployment the effective ceiling is N×5 —
// acceptable for the demo. See common/rate-limiter.ts for the
// implementation note.
const otpSendLimiter = new RateLimiter(5, 5 * 60 * 1000);

export type OtpType = 'phone' | 'email';

export type SendOtpInput = { target?: string; type?: OtpType };
export type VerifyOtpInput = { target?: string; code?: string };

const CODE_LENGTH = 4;
const TTL_MINUTES = 5;

// Email-shape sanity check. The full RFC is a tarpit; this catches
// obvious typos (no @, no dot in domain) without rejecting valid
// uncommon shapes. The downstream Resend `to` is the authoritative
// final check.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class OtpService {
  private readonly logger = new Logger('Otp');

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
  ) {}

  // Core OTP send. Always:
  //   1. Normalises target (phone → E.164; email → lowercase).
  //   2. Generates a real random 4-digit code.
  //   3. Persists it to the Otp table.
  //   4. Dispatches to the right transport (Taqnyat for phone,
  //      Resend for email).
  //   5. Returns { ok, expiresAt }. The code is NEVER returned to
  //      the caller — it has to land via the real channel.
  //
  // No dev-mode bypass, no fixed code, no auto-verify shortcut. If
  // the transport isn't configured we LOG an error and still return
  // ok (the row is persisted; an admin can pull the code from the
  // DB if absolutely necessary), but a normal user will never
  // receive the code and the verify step will reject them. This is
  // the safer default — never silently auto-verify.
  async send(body: SendOtpInput) {
    const rawTarget = body.target?.trim();
    const type = body.type === 'email' ? 'email' : 'phone';

    if (!rawTarget) {
      throw new BadRequestException('target is required');
    }

    // Normalise BEFORE anything else so the rate-limit key, the
    // Otp row, and the transport call all see the same canonical
    // form. A user typing "0501234567" and one typing "+966 50 123
    // 4567" share a single rate-limit bucket and a single Otp row.
    const target =
      type === 'phone' ? normalizePhone(rawTarget) : rawTarget.toLowerCase();

    if (!target) {
      this.logger.warn(
        `[otp:reject] type=${type} reason=invalid-target raw="${rawTarget}"`,
      );
      throw new BadRequestException(
        type === 'phone' ? 'invalid_phone' : 'invalid_email',
      );
    }
    if (type === 'email' && !EMAIL_REGEX.test(target)) {
      this.logger.warn(
        `[otp:reject] type=email reason=invalid-shape raw="${rawTarget}"`,
      );
      throw new BadRequestException('invalid_email');
    }

    // Rate limit BEFORE writing the row. Returns 429 with a stable
    // code so the frontend can render a friendly "you've requested
    // too many codes — try again in a few minutes" message without
    // parsing localized strings.
    if (!otpSendLimiter.hit(`otp:${target}`)) {
      this.logger.warn(`[otp:rate-limited] type=${type} target=${target}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'otp_rate_limited',
          message: 'Too many OTP requests — please wait a few minutes',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Real random code. Always. No env-var shortcut, no fixed value.
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

    this.logger.log(
      `[otp:generated] type=${type} target=${target} expires=${expiresAt.toISOString()}`,
    );

    // Persist FIRST so the auth flow can verify against the row even
    // if delivery is slow or fails. AuthService.register and
    // OtpService.verify both read from this same row.
    await this.prisma.otp.create({
      data: { target, code, type, expiresAt },
    });

    // Dispatch. Each transport is its own swallow-errors path —
    // a phone delivery failure can't break the email path and
    // vice-versa. Errors are LOGGED loudly so an ops alert can
    // grep "[otp:dispatch-failed]" in production.
    if (type === 'phone') {
      await this.dispatchSms(target, code);
    } else {
      await this.dispatchEmail(target, code);
    }

    return { ok: true, expiresAt };
  }

  // Email dispatch via Resend. MailService.sendOtpEmail returns
  // `{ ok, id, reason }` and never throws — we surface the result
  // here as a structured log line per attempt so ops can correlate
  // user complaints with Resend's dashboard.
  private async dispatchEmail(target: string, code: string) {
    if (!this.mail.isConfigured()) {
      this.logger.error(
        `[otp:dispatch-failed] type=email target=${target} reason=mail-not-configured ` +
          'set RESEND_API_KEY on the API to enable real email OTP delivery.',
      );
      return;
    }
    this.logger.log(`[otp:dispatch] type=email target=${target} via=resend`);
    const result = await this.mail.sendOtpEmail({
      to: target,
      code,
      ttlMinutes: TTL_MINUTES,
      lang: 'ar',
    });
    if (result.ok) {
      this.logger.log(
        `[otp:sent] type=email target=${target} provider-id=${result.id ?? '(none)'}`,
      );
    } else {
      this.logger.error(
        `[otp:dispatch-failed] type=email target=${target} reason=${result.reason ?? 'unknown'}`,
      );
    }
  }

  // SMS dispatch via Taqnyat. Same pattern as email: structured log
  // line per attempt; never throws back to the caller.
  private async dispatchSms(target: string, code: string) {
    const token = process.env.TAQNYAT_BEARER_TOKEN?.trim();
    if (!token) {
      this.logger.error(
        `[otp:dispatch-failed] type=phone target=${target} reason=taqnyat-not-configured ` +
          'set TAQNYAT_BEARER_TOKEN on the API to enable real SMS OTP delivery.',
      );
      return;
    }
    const message = `رمز التحقق الخاص بك هو: ${code}`;
    this.logger.log(`[otp:dispatch] type=phone target=${target} via=taqnyat`);
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
      const data: unknown = await res.json().catch(() => null);
      if (res.ok) {
        this.logger.log(
          `[otp:sent] type=phone target=${target} taqnyat-status=${res.status}`,
        );
      } else {
        this.logger.error(
          `[otp:dispatch-failed] type=phone target=${target} ` +
            `taqnyat-status=${res.status} body=${JSON.stringify(data)}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[otp:dispatch-failed] type=phone target=${target} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async verify(body: VerifyOtpInput) {
    const rawTarget = body.target?.trim();
    const code = body.code?.trim();

    if (!rawTarget || !code) {
      throw new BadRequestException('target and code are required');
    }

    // Normalise the target the same way send() did so a user who
    // typed "0501234567" at send time and "+966501234567" at verify
    // time still resolves to the same Otp row.
    const target = rawTarget.includes('@')
      ? rawTarget.toLowerCase()
      : (normalizePhone(rawTarget) ?? rawTarget);

    const otp = await this.prisma.otp.findFirst({
      where: { target },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.code !== code) {
      this.logger.warn(
        `[otp:verify-failed] target=${target} reason=invalid-code`,
      );
      throw new BadRequestException('invalid_code');
    }
    if (otp.expiresAt.getTime() < Date.now()) {
      this.logger.warn(`[otp:verify-failed] target=${target} reason=expired`);
      throw new BadRequestException('expired_code');
    }

    // Single-use: best-effort delete so the code can't be replayed.
    await this.prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    this.logger.log(`[otp:verify-success] target=${target}`);

    return { ok: true };
  }

  private generateCode(): string {
    const max = 10 ** CODE_LENGTH;
    const min = 10 ** (CODE_LENGTH - 1);
    const n = Math.floor(min + Math.random() * (max - min));
    return String(n);
  }
}
