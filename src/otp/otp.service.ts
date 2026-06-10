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

// PR 3 (platform stabilization): 6 digits, up from 4. Code space
// grows 10,000 → 1,000,000, which combined with the attempt caps
// below puts a brute-force success inside one TTL window at ~1e-5.
// The frontend OtpInput length ships in the paired qift-ui-v2 PR —
// merge order: backend first, frontend immediately after (in-flight
// 4-digit codes expire within the 5-minute TTL either way).
const CODE_LENGTH = 6;
const TTL_MINUTES = 5;

// Week 1 security hardening (F1) — per-OTP-row verify-attempt cap.
// We use the existing `Otp.attempts` column (already in the schema
// with default 0): every wrong-code attempt increments it; once it
// reaches MAX_VERIFY_ATTEMPTS the row is dead and verify rejects
// with `otp_locked` BEFORE comparing the code.
const MAX_VERIFY_ATTEMPTS = 5;

// PR 3 — resend-safe lockout. The per-row cap alone resets every
// time a fresh OTP is requested (new row, attempts=0), so an
// attacker alternating guess-bursts with resends got a fresh budget
// each time. This cap aggregates wrong attempts across ALL of a
// target's rows in a sliding window — send() never deletes prior
// rows, so the history (and the lockout) survives resends. It is
// DB-backed, which also makes it replica-safe where the in-memory
// send limiter is per-process. A successful verify deletes its row
// (single-use), naturally releasing that row's attempts — correct,
// since the budget exists to stop guessing, not to punish success.
// 10 wrong guesses / 15 min against a 1,000,000-code space keeps
// the attack math negligible while leaving honest fat-fingering
// (2-3 typos per code, even across a resend) comfortably inside
// the budget.
const MAX_TARGET_ATTEMPTS = 10;
const TARGET_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

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
  //   2. Refuses up-front when the requested transport isn't
  //      configured (503 with `sms_unavailable` / `email_unavailable`)
  //      so the frontend can immediately offer the other channel
  //      instead of accepting the request, persisting an Otp row,
  //      and silently failing to deliver. The previous behaviour
  //      (return ok=true even when dispatch was impossible) made
  //      the user type a code that never arrived.
  //   3. Generates a real random 4-digit code.
  //   4. Persists it to the Otp table.
  //   5. Dispatches to the right transport (Taqnyat for phone,
  //      Resend for email).
  //   6. Returns { ok, expiresAt, dispatched, channel }. The code is
  //      NEVER returned to the caller — it has to land via the real
  //      channel.
  //
  // No dev-mode bypass, no fixed code, no auto-verify shortcut.
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

    // Transport-availability gate. Refuse the send if the provider
    // for the requested channel isn't configured — better to surface
    // the fallback choice immediately than to swallow the request and
    // leave the user staring at an OTP screen for a code that will
    // never arrive. The frontend reads the typed `code` to switch the
    // toggle to the other channel.
    if (type === 'phone' && !this.smsConfigured()) {
      this.logger.warn(
        `[otp:reject] type=phone target=${target} reason=sms-unavailable`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'sms_unavailable',
          message:
            'SMS delivery is not configured on the server — try email instead.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (type === 'email' && !this.mail.isConfigured()) {
      this.logger.warn(
        `[otp:reject] type=email target=${target} reason=email-unavailable`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'email_unavailable',
          message:
            'Email delivery is not configured on the server — try SMS instead.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
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
    const dispatched =
      type === 'phone'
        ? await this.dispatchSms(target, code)
        : await this.dispatchEmail(target, code);

    return { ok: true, expiresAt, dispatched, channel: type };
  }

  // Cheap availability check for the SMS path. Lives next to send()
  // so it can be reused by the up-front transport gate above and the
  // dispatch path below — keeping both readings in sync.
  private smsConfigured(): boolean {
    return !!process.env.TAQNYAT_BEARER_TOKEN?.trim();
  }

  // Email dispatch via Resend. MailService.sendOtpEmail returns
  // `{ ok, id, reason }` and never throws — we surface the result
  // here as a structured log line per attempt so ops can correlate
  // user complaints with Resend's dashboard. Returns true only when
  // Resend acknowledged the send; the caller threads this back as
  // `dispatched` on the response so the frontend can warn the user
  // when delivery is uncertain.
  private async dispatchEmail(target: string, code: string): Promise<boolean> {
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
      return true;
    }
    this.logger.error(
      `[otp:dispatch-failed] type=email target=${target} reason=${result.reason ?? 'unknown'}`,
    );
    return false;
  }

  // SMS dispatch via Taqnyat. Same pattern as email: structured log
  // line per attempt; never throws back to the caller. The token
  // presence check is duplicated here as belt-and-braces — the up-
  // front gate in send() already refused with `sms_unavailable`, but
  // a hot-rotation that yanks the token between gate + dispatch
  // shouldn't crash the request.
  private async dispatchSms(target: string, code: string): Promise<boolean> {
    const token = process.env.TAQNYAT_BEARER_TOKEN?.trim();
    if (!token) {
      this.logger.error(
        `[otp:dispatch-failed] type=phone target=${target} reason=taqnyat-not-configured`,
      );
      return false;
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
        return true;
      }
      this.logger.error(
        `[otp:dispatch-failed] type=phone target=${target} ` +
          `taqnyat-status=${res.status} body=${JSON.stringify(data)}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[otp:dispatch-failed] type=phone target=${target} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
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

    // PR 3 — resend-safe lockout, checked BEFORE the row lookup.
    // Sums wrong attempts across every row this target accumulated
    // in the window; requesting a fresh code does NOT reset it (the
    // old rows keep their counts). Same `otp_locked` the per-row cap
    // throws, so frontends need no new error handling. Recovery is
    // simply waiting out the window.
    const windowed = await this.prisma.otp.aggregate({
      _sum: { attempts: true },
      where: {
        target,
        createdAt: { gte: new Date(Date.now() - TARGET_ATTEMPT_WINDOW_MS) },
      },
    });
    if ((windowed._sum.attempts ?? 0) >= MAX_TARGET_ATTEMPTS) {
      this.logger.warn(
        `[otp:verify-failed] target=${target} reason=target-locked ` +
          `windowAttempts=${windowed._sum.attempts}`,
      );
      throw new BadRequestException('otp_locked');
    }

    const otp = await this.prisma.otp.findFirst({
      where: { target },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      // No row at all — same observable behaviour as before. Don't
      // distinguish 'no code requested' from 'wrong code' to keep
      // the response shape uniform for an enumeration-resistant
      // contract.
      this.logger.warn(`[otp:verify-failed] target=${target} reason=no-code`);
      throw new BadRequestException('invalid_code');
    }

    // F1 lockout check — runs BEFORE the code comparison so an
    // attacker who has burned MAX_VERIFY_ATTEMPTS on this row cannot
    // bypass the cap by submitting one more guess. The user-facing
    // recovery path is to request a fresh OTP via /otp/send (the
    // new row starts at attempts=0) — but the target-window cap
    // above still counts the burned rows, so resends only help an
    // honest user, never extend an attacker's budget.
    if (otp.attempts >= MAX_VERIFY_ATTEMPTS) {
      this.logger.warn(
        `[otp:verify-failed] target=${target} reason=locked attempts=${otp.attempts}`,
      );
      throw new BadRequestException('otp_locked');
    }

    if (otp.expiresAt.getTime() < Date.now()) {
      // Expiry runs BEFORE the code comparison so expired rows
      // emit a distinct error code (UX: the frontend prompts the
      // user to request a new code). Expiry deliberately does NOT
      // increment `attempts` — an expired row is dead either way,
      // and incrementing here would conflate two failure modes.
      this.logger.warn(`[otp:verify-failed] target=${target} reason=expired`);
      throw new BadRequestException('expired_code');
    }

    if (otp.code !== code) {
      // Wrong code. Increment `attempts` on this row so a brute-force
      // attacker exhausts the budget. The update is best-effort
      // (catch + swallow) — a transient DB hiccup must NOT change the
      // error returned to the user, who still gets 'invalid_code'.
      // The update uses an atomic increment so concurrent verify
      // attempts each contribute exactly one to the counter.
      await this.prisma.otp
        .update({
          where: { id: otp.id },
          data: { attempts: { increment: 1 } },
        })
        .catch(() => {
          // Logged as a warn; do not throw — the user-facing error
          // path is `invalid_code` regardless.
          this.logger.warn(
            `[otp:verify-failed] target=${target} reason=attempt-increment-failed`,
          );
        });
      this.logger.warn(
        `[otp:verify-failed] target=${target} reason=invalid-code attempts=${otp.attempts + 1}`,
      );
      throw new BadRequestException('invalid_code');
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
