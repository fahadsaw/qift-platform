// Email templates. Plain functions returning { subject, html, text } so
// the MailService doesn't reach for a templating engine just for five
// well-defined messages. Every template is responsive (max-width 600,
// inline CSS, table-based layout for Outlook compatibility) and
// supports both Arabic-RTL and English-LTR — `lang` parameter chooses.
//
// Design rules:
//   - Plain HTML email — no Tailwind, no custom fonts (best deliverability).
//   - All styling inline; <style> blocks are stripped by Gmail/Outlook.
//   - Use system font stack so the email renders correctly without
//     remote font loading (which iOS Mail and Gmail mobile both block).
//   - The brand mark renders as text in a primary-color pill so it
//     works without any image — emails with images get clipped on
//     low-bandwidth previews.
//   - Plaintext fallback (`text`) included so spam filters that score
//     image-heavy messages don't punish us; Gmail also uses it for
//     accessibility readers.

const PRIMARY = '#7B5CF5';
const PRIMARY_DARK = '#6344E8';
const INK = '#0F0B18';
const TEXT_SOFT = '#525158';
const MUTED = '#8A8995';
const BORDER = '#E6E4F0';
const BG_SOFT = '#F8F6FE';

export type EmailLang = 'ar' | 'en';

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

// Shared shell. Wraps every body block in the same brand frame so
// every email — OTP, welcome, gift, password reset, merchant — feels
// like the same product. `body` is the raw HTML to inject; `lang`
// flips dir + line-break.
function renderShell(opts: {
  lang: EmailLang;
  preheader: string;
  bodyHtml: string;
  ctaUrl?: string;
  ctaLabel?: string;
  footerLines: string[];
}): string {
  const { lang, preheader, bodyHtml, ctaUrl, ctaLabel, footerLines } = opts;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Qift</title>
  </head>
  <body style="margin:0;padding:0;background:${BG_SOFT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${INK};">
    <span style="display:none;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escape(preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG_SOFT};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:24px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:6px 14px;border-radius:999px;background:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 100%);color:#ffffff;font-size:14px;font-weight:700;letter-spacing:0.04em;">
                      Qift · قِفت
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 8px 32px;">
                ${bodyHtml}
              </td>
            </tr>
            ${
              ctaUrl && ctaLabel
                ? `<tr>
              <td style="padding:8px 32px 24px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="border-radius:999px;background:linear-gradient(135deg,${PRIMARY} 0%,${PRIMARY_DARK} 100%);">
                      <a href="${escapeAttr(ctaUrl)}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;border-radius:999px;">${escape(ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
                : ''
            }
            <tr>
              <td style="padding:16px 32px 28px 32px;border-top:1px solid ${BORDER};color:${MUTED};font-size:12px;line-height:1.6;">
                ${footerLines.map((l) => `<div>${escape(l)}</div>`).join('\n                ')}
              </td>
            </tr>
          </table>
          <div style="margin-top:16px;color:${MUTED};font-size:11px;">
            © ${new Date().getFullYear()} Qift · qift.net
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Small HTML escapers. We never interpolate user input that hasn't
// been validated, but defence-in-depth keeps a future caller from
// accidentally injecting into a subject line via a stray `<` in a
// product name.
function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escape(s).replace(/`/g, '&#96;');
}

// ── OTP ──────────────────────────────────────────────────────────────
// Premium, security-conscious code email. Big monospaced code block,
// expiration window, security note, plaintext fallback. AR + EN.
export function renderOtpEmail(args: {
  code: string;
  ttlMinutes: number;
  lang: EmailLang;
  supportEmail: string;
}): RenderedEmail {
  const { code, ttlMinutes, lang, supportEmail } = args;
  const ar = lang === 'ar';
  const subject = ar
    ? `رمز التحقق: ${code}`
    : `Your Qift verification code: ${code}`;
  const preheader = ar
    ? `استخدم الرمز ${code} لإكمال تسجيل الدخول. ينتهي خلال ${ttlMinutes} دقائق.`
    : `Use code ${code} to finish signing in. Expires in ${ttlMinutes} minutes.`;

  const bodyHtml = ar
    ? `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">رمز تحقق قِفت</h1>
      <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">
        أدخل الرمز التالي لإكمال عملية تسجيل الدخول إلى حساب قِفت. لا تشاركه مع أي شخص.
      </p>
      <div style="text-align:center;margin:18px 0 22px 0;padding:18px 24px;background:${BG_SOFT};border:1px solid ${BORDER};border-radius:18px;">
        <div style="font-family:'Menlo','Consolas',monospace;font-size:34px;font-weight:800;letter-spacing:8px;color:${PRIMARY};direction:ltr;">${escape(code)}</div>
        <div style="margin-top:6px;font-size:12px;color:${MUTED};">صالح لمدة ${ttlMinutes} دقائق</div>
      </div>
      <p style="margin:0 0 12px 0;font-size:13px;line-height:1.65;color:${TEXT_SOFT};">
        إذا لم تطلب هذا الرمز فيمكنك تجاهل هذه الرسالة بأمان — لن يتم اتخاذ أي إجراء على حسابك.
      </p>
      <p style="margin:0;font-size:12px;color:${MUTED};">
        فريق قِفت لن يطلب منك مشاركة هذا الرمز عبر البريد أو الهاتف أو أي قناة أخرى.
      </p>
    `
    : `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">Your Qift verification code</h1>
      <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">
        Enter the code below to finish signing in to your Qift account. Don't share it with anyone.
      </p>
      <div style="text-align:center;margin:18px 0 22px 0;padding:18px 24px;background:${BG_SOFT};border:1px solid ${BORDER};border-radius:18px;">
        <div style="font-family:'Menlo','Consolas',monospace;font-size:34px;font-weight:800;letter-spacing:8px;color:${PRIMARY};">${escape(code)}</div>
        <div style="margin-top:6px;font-size:12px;color:${MUTED};">Valid for ${ttlMinutes} minutes</div>
      </div>
      <p style="margin:0 0 12px 0;font-size:13px;line-height:1.65;color:${TEXT_SOFT};">
        Didn't request this? You can safely ignore this email — no action will be taken on your account.
      </p>
      <p style="margin:0;font-size:12px;color:${MUTED};">
        Qift will never ask you to share this code by email, phone, or any other channel.
      </p>
    `;

  const html = renderShell({
    lang,
    preheader,
    bodyHtml,
    footerLines: ar
      ? ['هذه الرسالة مرسلة من قِفت.', `للاستفسارات: ${supportEmail}`]
      : [
          'This email was sent by Qift.',
          `Questions? Contact us at ${supportEmail}.`,
        ],
  });

  const text = ar
    ? [
        'رمز تحقق قِفت',
        '',
        `الرمز: ${code}`,
        `صالح لمدة ${ttlMinutes} دقائق.`,
        '',
        'لا تشارك هذا الرمز مع أي شخص. فريق قِفت لن يطلبه منك.',
        '',
        `للاستفسارات: ${supportEmail}`,
      ].join('\n')
    : [
        'Your Qift verification code',
        '',
        `Code: ${code}`,
        `Valid for ${ttlMinutes} minutes.`,
        '',
        "Don't share this code with anyone. Qift will never ask for it.",
        '',
        `Questions? Contact us at ${supportEmail}.`,
      ].join('\n');

  return { subject, html, text };
}

// ── Welcome ──────────────────────────────────────────────────────────
export function renderWelcomeEmail(args: {
  fullName: string | null;
  username: string;
  lang: EmailLang;
  appUrl: string;
  supportEmail: string;
}): RenderedEmail {
  const { fullName, username, lang, appUrl, supportEmail } = args;
  const ar = lang === 'ar';
  const greetName = (fullName ?? '').trim() || `@${username}`;
  const subject = ar ? `أهلًا بك في قِفت 🎁` : `Welcome to Qift 🎁`;
  const preheader = ar
    ? 'تجربة إهداء جديدة كلّيًا — بدون عنوان.'
    : 'A new way to gift — no address required.';

  const bodyHtml = ar
    ? `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">أهلًا بك ${escape(greetName)} 🎁</h1>
      <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">
        حسابك في قِفت جاهز. الآن يمكنك إرسال واستقبال الهدايا باستخدام اسم المستخدم فقط — بدون مشاركة العنوان.
      </p>
      <ul style="margin:0 0 16px 0;padding:0 18px 0 0;font-size:14px;line-height:1.85;color:${TEXT_SOFT};">
        <li>أرسل هدية لأي مستخدم بكتابة @${escape(username === '' ? 'username' : 'someone')}</li>
        <li>أضف عنوانك الافتراضي مرة واحدة لاستقبال الهدايا</li>
        <li>تابع حالة هداياك المرسلة والمستلمة في أي وقت</li>
      </ul>
    `
    : `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">Welcome, ${escape(greetName)} 🎁</h1>
      <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">
        Your Qift account is ready. You can now send and receive gifts with just a username — no addresses to share.
      </p>
      <ul style="margin:0 0 16px 0;padding-inline-start:18px;font-size:14px;line-height:1.85;color:${TEXT_SOFT};">
        <li>Send a gift to any user by typing @username</li>
        <li>Add a default delivery address once to receive gifts</li>
        <li>Track every gift you've sent or received in real time</li>
      </ul>
    `;

  const html = renderShell({
    lang,
    preheader,
    bodyHtml,
    ctaUrl: appUrl,
    ctaLabel: ar ? 'افتح قِفت' : 'Open Qift',
    footerLines: ar
      ? ['شكرًا لانضمامك إلى قِفت.', `للاستفسارات: ${supportEmail}`]
      : ['Thanks for joining Qift.', `Questions? ${supportEmail}`],
  });

  const text = ar
    ? `أهلًا بك ${greetName}. حسابك في قِفت جاهز. ${appUrl}`
    : `Welcome, ${greetName}. Your Qift account is ready. ${appUrl}`;
  return { subject, html, text };
}

// ── Gift notification ────────────────────────────────────────────────
// Generic gift-flow email. Used for every milestone the operator
// wants to push to the channel: gift sent, address confirmed, gift
// shipped, gift delivered. Subject + heading come from the caller so
// the template stays milestone-agnostic.
export function renderGiftNotificationEmail(args: {
  recipientName: string;
  headingAr: string;
  headingEn: string;
  bodyAr: string;
  bodyEn: string;
  giftUrl: string;
  lang: EmailLang;
  supportEmail: string;
}): RenderedEmail {
  const { headingAr, headingEn, bodyAr, bodyEn, giftUrl, lang, supportEmail } =
    args;
  const ar = lang === 'ar';
  const subject = ar ? headingAr : headingEn;
  const heading = ar ? headingAr : headingEn;
  const body = ar ? bodyAr : bodyEn;
  const preheader = body.slice(0, 120);

  const bodyHtml = `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">${escape(heading)}</h1>
      <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">${escape(body)}</p>
    `;

  const html = renderShell({
    lang,
    preheader,
    bodyHtml,
    ctaUrl: giftUrl,
    ctaLabel: ar ? 'فتح الهدية' : 'Open gift',
    footerLines: ar
      ? ['تنبيه من قِفت بشأن هديتك.', `للاستفسارات: ${supportEmail}`]
      : ['A gift update from Qift.', `Questions? ${supportEmail}`],
  });

  const text = `${heading}\n\n${body}\n\n${giftUrl}`;
  return { subject, html, text };
}

// ── Password reset ───────────────────────────────────────────────────
export function renderPasswordResetEmail(args: {
  resetUrl: string;
  ttlMinutes: number;
  lang: EmailLang;
  supportEmail: string;
}): RenderedEmail {
  const { resetUrl, ttlMinutes, lang, supportEmail } = args;
  const ar = lang === 'ar';
  const subject = ar ? 'إعادة تعيين كلمة المرور' : 'Reset your Qift password';
  const preheader = ar
    ? `صالح لمدة ${ttlMinutes} دقيقة.`
    : `Valid for ${ttlMinutes} minutes.`;

  const bodyHtml = ar
    ? `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">إعادة تعيين كلمة المرور</h1>
      <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">
        تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك. الرابط أدناه صالح لمدة ${ttlMinutes} دقيقة.
      </p>
      <p style="margin:0 0 12px 0;font-size:13px;line-height:1.65;color:${TEXT_SOFT};">
        إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة. كلمة مرورك الحالية ستظل سارية.
      </p>
    `
    : `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">Reset your password</h1>
      <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">
        We received a request to reset your password. The link below is valid for ${ttlMinutes} minutes.
      </p>
      <p style="margin:0 0 12px 0;font-size:13px;line-height:1.65;color:${TEXT_SOFT};">
        If you didn't request this, you can ignore this email — your current password is still active.
      </p>
    `;

  const html = renderShell({
    lang,
    preheader,
    bodyHtml,
    ctaUrl: resetUrl,
    ctaLabel: ar ? 'إعادة تعيين كلمة المرور' : 'Reset password',
    footerLines: ar
      ? ['طلب إعادة تعيين من قِفت.', `للاستفسارات: ${supportEmail}`]
      : ['Password reset requested via Qift.', `Questions? ${supportEmail}`],
  });

  const text = ar
    ? `إعادة تعيين كلمة المرور — ${resetUrl}\nصالح لمدة ${ttlMinutes} دقيقة.`
    : `Reset your password — ${resetUrl}\nValid for ${ttlMinutes} minutes.`;
  return { subject, html, text };
}

// ── Merchant notification ────────────────────────────────────────────
export function renderMerchantNotificationEmail(args: {
  storeName: string;
  headingAr: string;
  headingEn: string;
  bodyAr: string;
  bodyEn: string;
  dashboardUrl: string;
  lang: EmailLang;
  supportEmail: string;
}): RenderedEmail {
  const {
    storeName,
    headingAr,
    headingEn,
    bodyAr,
    bodyEn,
    dashboardUrl,
    lang,
    supportEmail,
  } = args;
  const ar = lang === 'ar';
  const subject = ar
    ? `${headingAr} — ${storeName}`
    : `${headingEn} — ${storeName}`;
  const heading = ar ? headingAr : headingEn;
  const body = ar ? bodyAr : bodyEn;
  const preheader = body.slice(0, 120);

  const bodyHtml = `
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:${INK};">${escape(heading)}</h1>
      <p style="margin:0 0 6px 0;font-size:13px;color:${MUTED};">${escape(storeName)}</p>
      <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;color:${TEXT_SOFT};">${escape(body)}</p>
    `;

  const html = renderShell({
    lang,
    preheader,
    bodyHtml,
    ctaUrl: dashboardUrl,
    ctaLabel: ar ? 'فتح لوحة المتجر' : 'Open store dashboard',
    footerLines: ar
      ? ['تنبيه متجر من قِفت.', `للاستفسارات: ${supportEmail}`]
      : ['Merchant alert from Qift.', `Questions? ${supportEmail}`],
  });

  const text = `${heading} — ${storeName}\n\n${body}\n\n${dashboardUrl}`;
  return { subject, html, text };
}
