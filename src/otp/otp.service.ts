import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type OtpType = 'phone' | 'email';

export type SendOtpInput = { target?: string; type?: OtpType };
export type VerifyOtpInput = { target?: string; code?: string };

const CODE_LENGTH = 4;
const TTL_MINUTES = 5;

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

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

    // Persist FIRST so the auth flow can verify against the row even if
    // SMS delivery is slow or fails. AuthService.register and
    // OtpService.verify both read from the same Otp table.
    await this.prisma.otp.create({
      data: { target, code, type, expiresAt },
    });

    // Dev-mode visibility: log the code to the server console so we can
    // sign in without actually receiving an SMS. Two channels because
    // some pino setups suppress one or the other.
    this.logger.log(`OTP for ${type} ${target}: ${code}`);
    console.log('OTP:', code);

    // Out-of-band delivery. Failure is non-fatal in dev — the console log
    // above is the fallback. Production deployments should monitor the
    // `SMS Error` log and consider escalating on persistent failure.
    if (type === 'phone') {
      await this.sendSmsViaTaqnyat(target, `رمز التحقق الخاص بك هو: ${code}`);
    }

    return { ok: true, expiresAt };
  }

  // Taqnyat is the SMS provider used in production. The bearer token
  // lives in TAQNYAT_BEARER_TOKEN. When the env var is missing we skip
  // the call (typical in local dev) — the dev console log path still
  // reveals the code so flows aren't blocked.
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
        'TAQNYAT_BEARER_TOKEN not set — skipping SMS, dev log only',
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
          // Taqnyat expects digits only — strip the leading "+" we accept
          // from clients in E.164 form.
          recipients: [target.replace('+', '')],
          body: message,
        }),
      });
      const data: unknown = await res.json();
      this.logger.log(`Taqnyat response: ${JSON.stringify(data)}`);
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
