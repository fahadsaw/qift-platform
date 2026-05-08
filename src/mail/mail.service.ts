import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { RateLimiter } from '../common/rate-limiter';
import {
  renderGiftNotificationEmail,
  renderMerchantNotificationEmail,
  renderOtpEmail,
  renderPasswordResetEmail,
  renderWelcomeEmail,
  type EmailLang,
} from './mail.templates';

// Centralized transactional email service. Wraps the Resend SDK with
// a single, type-safe surface that the rest of the codebase calls.
//
// Architecture choices:
//
//   - Lazy SDK init. The Resend client is only constructed when
//     RESEND_API_KEY is present. Without the key the service still
//     loads (so the app boots fine in any env) but every send no-ops
//     with a warn log. This mirrors the push-service pattern: missing
//     transport ≠ application failure.
//
//   - Per-recipient rate limit. Light defence against accidental
//     resend loops or a runaway notification fan-out: 10 sends per
//     recipient per 5 minutes. In-memory; same caveats as the OTP
//     limiter (per-process, leaky under N replicas, fine at our
//     scale). Lifts to Redis when the rest of the rate-limit story
//     does.
//
//   - Two retries on transient failures. Resend's API can return
//     transient 5xx during incidents; we re-try with a small backoff
//     before giving up. 4xx errors (invalid recipient, blocked sender,
//     etc.) are NOT retried — those are caller bugs that retrying
//     won't fix.
//
//   - From / OTP-from / support addresses come from env vars. Each
//     defaults to the canonical qift.net mailbox so a missing config
//     still produces a deliverable address (DKIM is keyed on the
//     domain, not the local part).
//
//   - Errors are SWALLOWED at the call site. Email is best-effort:
//     a failed welcome email shouldn't roll back a successful
//     register call. Callers receive `{ ok: boolean }` they can log
//     or surface, but never an exception.

// Per-recipient send rate. Generous (10 / 5min) — at this rate a
// pathological loop hits the ceiling within ~30s and stops, but a
// legitimate burst (welcome + first gift + first notification all
// within a minute) is never blocked.
const sendLimiter = new RateLimiter(10, 5 * 60 * 1000);

// Resend SDK transient-error detection. The library throws a typed
// error with a `statusCode`; we treat 5xx + network errors as worth
// a retry and 4xx as terminal.
function isTransient(err: unknown): boolean {
  const status =
    typeof err === 'object' && err !== null && 'statusCode' in err
      ? (err as { statusCode?: number }).statusCode
      : undefined;
  if (typeof status === 'number') return status >= 500;
  // Likely a fetch / DNS error — retry once.
  return true;
}

const RETRY_DELAYS_MS = [400, 1200];

export type SendResult = {
  ok: boolean;
  // Resend's message id when delivery was accepted. `null` when we
  // skipped (no API key, rate-limited, or all retries failed).
  id: string | null;
  // Diagnostic reason; useful in logs and as a smoke-test signal.
  reason?:
    | 'sent'
    | 'no-api-key'
    | 'rate-limited'
    | 'invalid-recipient'
    | 'send-failed';
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private client: Resend | null = null;
  private readonly defaultFrom: string;
  private readonly otpFrom: string;
  private readonly supportEmail: string;
  private readonly siteOrigin: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    this.defaultFrom = process.env.EMAIL_FROM?.trim() || 'noreply@qift.net';
    this.otpFrom = process.env.OTP_EMAIL_FROM?.trim() || 'otp@qift.net';
    this.supportEmail = process.env.SUPPORT_EMAIL?.trim() || 'support@qift.net';
    this.siteOrigin = (process.env.SITE_ORIGIN ?? 'https://qift.net').replace(
      /\/+$/,
      '',
    );

    if (apiKey) {
      this.client = new Resend(apiKey);
    } else {
      this.logger.warn(
        'RESEND_API_KEY not set — transactional emails are disabled. ' +
          'Set the env var on Railway to enable real delivery.',
      );
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  // ── Public methods ─────────────────────────────────────────────

  async sendOtpEmail(args: {
    to: string;
    code: string;
    ttlMinutes: number;
    lang?: EmailLang;
  }): Promise<SendResult> {
    const lang = args.lang ?? 'ar';
    const tpl = renderOtpEmail({
      code: args.code,
      ttlMinutes: args.ttlMinutes,
      lang,
      supportEmail: this.supportEmail,
    });
    return this.send({
      to: args.to,
      from: this.brandedFrom(this.otpFrom, lang),
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: 'otp',
    });
  }

  async sendWelcomeEmail(args: {
    to: string;
    fullName: string | null;
    username: string;
    lang?: EmailLang;
  }): Promise<SendResult> {
    const lang = args.lang ?? 'ar';
    const tpl = renderWelcomeEmail({
      fullName: args.fullName,
      username: args.username,
      lang,
      appUrl: this.siteOrigin,
      supportEmail: this.supportEmail,
    });
    return this.send({
      to: args.to,
      from: this.brandedFrom(this.defaultFrom, lang),
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: 'welcome',
    });
  }

  async sendGiftNotificationEmail(args: {
    to: string;
    recipientName: string;
    giftId: string;
    headingAr: string;
    headingEn: string;
    bodyAr: string;
    bodyEn: string;
    lang?: EmailLang;
  }): Promise<SendResult> {
    const lang = args.lang ?? 'ar';
    const tpl = renderGiftNotificationEmail({
      recipientName: args.recipientName,
      headingAr: args.headingAr,
      headingEn: args.headingEn,
      bodyAr: args.bodyAr,
      bodyEn: args.bodyEn,
      giftUrl: `${this.siteOrigin}/gifts/${encodeURIComponent(args.giftId)}`,
      lang,
      supportEmail: this.supportEmail,
    });
    return this.send({
      to: args.to,
      from: this.brandedFrom(this.defaultFrom, lang),
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: 'gift',
    });
  }

  async sendPasswordResetEmail(args: {
    to: string;
    resetToken: string;
    ttlMinutes?: number;
    lang?: EmailLang;
  }): Promise<SendResult> {
    const lang = args.lang ?? 'ar';
    const ttlMinutes = args.ttlMinutes ?? 30;
    const resetUrl = `${this.siteOrigin}/forgot-password?token=${encodeURIComponent(
      args.resetToken,
    )}`;
    const tpl = renderPasswordResetEmail({
      resetUrl,
      ttlMinutes,
      lang,
      supportEmail: this.supportEmail,
    });
    return this.send({
      to: args.to,
      from: this.brandedFrom(this.defaultFrom, lang),
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: 'password-reset',
    });
  }

  async sendMerchantNotificationEmail(args: {
    to: string;
    storeName: string;
    headingAr: string;
    headingEn: string;
    bodyAr: string;
    bodyEn: string;
    lang?: EmailLang;
  }): Promise<SendResult> {
    const lang = args.lang ?? 'ar';
    const tpl = renderMerchantNotificationEmail({
      storeName: args.storeName,
      headingAr: args.headingAr,
      headingEn: args.headingEn,
      bodyAr: args.bodyAr,
      bodyEn: args.bodyEn,
      dashboardUrl: `${this.siteOrigin}/store-dashboard`,
      lang,
      supportEmail: this.supportEmail,
    });
    // Merchant alerts come from a dedicated mailbox so an operator
    // can filter on it cleanly. We only override the local part —
    // the domain stays qift.net so DKIM still passes.
    const from = this.brandedFrom('merchants@qift.net', lang);
    return this.send({
      to: args.to,
      from,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tag: 'merchant',
    });
  }

  // ── Private send loop ──────────────────────────────────────────

  private async send(args: {
    to: string;
    from: string;
    subject: string;
    html: string;
    text: string;
    tag: string;
  }): Promise<SendResult> {
    const to = (args.to ?? '').trim().toLowerCase();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      this.logger.warn(`mail.send: invalid recipient (tag=${args.tag})`);
      return { ok: false, id: null, reason: 'invalid-recipient' };
    }
    if (!this.client) {
      // Service mode: no API key. Logs the subject so dev / staging
      // sees what would have been sent without falling over. Same
      // shape as the push service when VAPID is missing.
      this.logger.log(
        `[mail:no-api-key] tag=${args.tag} to=${to} subject="${args.subject}"`,
      );
      return { ok: false, id: null, reason: 'no-api-key' };
    }
    if (!sendLimiter.hit(`mail:${to}`)) {
      this.logger.warn(
        `[mail:rate-limited] tag=${args.tag} to=${to} — 10 sends / 5min ceiling reached`,
      );
      return { ok: false, id: null, reason: 'rate-limited' };
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await this.client.emails.send({
          from: args.from,
          to,
          subject: args.subject,
          html: args.html,
          text: args.text,
          tags: [{ name: 'kind', value: args.tag }],
        });
        // The SDK returns { data, error } rather than throwing on
        // application-level failures. Treat a populated `error` the
        // same as a thrown 4xx — log + bail without retrying.
        if (res.error) {
          this.logger.error(
            `[mail:resend-error] tag=${args.tag} to=${to} ` +
              `name=${res.error.name ?? '?'} message=${res.error.message ?? '?'}`,
          );
          return { ok: false, id: null, reason: 'send-failed' };
        }
        const id = res.data?.id ?? null;
        this.logger.log(
          `[mail:sent] tag=${args.tag} to=${to} id=${id ?? '(no-id)'}`,
        );
        return { ok: true, id, reason: 'sent' };
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === RETRY_DELAYS_MS.length) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    this.logger.error(
      `[mail:send-failed] tag=${args.tag} to=${to} ` +
        `error=${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
    return { ok: false, id: null, reason: 'send-failed' };
  }

  // Resend (and most ESPs) accepts an "Email Address" or
  // "Display Name <email@domain>" form. We add a friendly display
  // name so the recipient's inbox shows "Qift" or "قِفت" instead of
  // the raw `noreply@qift.net`. Different display name per locale
  // keeps Arabic clients reading right-to-left correctly.
  private brandedFrom(address: string, lang: EmailLang): string {
    const name = lang === 'ar' ? 'قِفت' : 'Qift';
    return `${name} <${address}>`;
  }
}
