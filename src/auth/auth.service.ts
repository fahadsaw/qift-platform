import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
// `bcryptjs` is the pure-JS implementation of bcrypt. We use it
// instead of the native `bcrypt` package because the latter requires
// node-gyp + Python + a C++ toolchain at install time, which fails
// silently on some Railway / Nixpacks builders — the install
// completes but the .node binary is never produced, and the import
// throws MODULE_NOT_FOUND at runtime. `bcryptjs` produces hashes in
// the exact same `$2a$`/`$2b$` format and exposes the same `hash` /
// `compare` signatures, so swapping is a one-line change with no
// data migration. Existing password hashes verify identically.
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { normalizePhone } from './phone-normalize';

export type RegisterInput = {
  fullName?: string;
  qiftUsername?: string;
  phone?: string;
  email?: string;
  password?: string;
  defaultAddress?: string;
  // OTP code. Required for every call. The backend verifies
  // (channel-target, code) against the Otp table BEFORE issuing any
  // JWT — this is the only credential proving ownership of the
  // chosen channel.
  code?: string;
  // Which channel the OTP was sent to. Defaults to 'phone' for
  // back-compat with older clients. When 'email', the verify lookup
  // and the existing-user search both key off `email` instead of
  // `phone`, and `emailVerifiedAt` is stamped on the new user
  // (phone stays unverified until a future flow proves it). When
  // 'phone', the historic behaviour applies.
  channel?: 'phone' | 'email';
};

export type LoginInput = {
  identifier?: string;
  password?: string;
};

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mail: MailService,
  ) {}

  // POST /auth/register — register OR login via phone OR email OTP.
  //
  // The endpoint is the only place a JWT can be minted via the OTP path,
  // so OTP verification happens HERE (not on the client). The caller
  // chooses a channel ('phone' or 'email') — Taqnyat is currently the
  // SMS provider but isn't always activated, so the email path exists
  // as a first-class alternative, not just a fallback.
  //
  // Mandatory regardless of channel: `code`, `phone` (because the User
  // schema requires a unique phone on every row even when the OTP
  // proved a different channel).
  // Mandatory when channel='email': `email`. The OTP row is keyed off
  // the canonical email (lowercased) and that's what we look up.
  //
  // Existing-user behaviour:
  //
  //   target exists  → log in. username/email/password from the body are
  //                    IGNORED (we don't trust client-supplied data to
  //                    override existing account fields). JWT for the
  //                    existing user is returned.
  //   target is new  → register. username + password are required;
  //                    uniqueness is enforced for username/email/phone;
  //                    a new user row is created and a JWT is returned.
  //                    The matching `*VerifiedAt` timestamp is stamped
  //                    only for the channel that was actually proven —
  //                    a phone-OTP signup leaves the email unverified
  //                    until a future verify flow proves it, and vice
  //                    versa.
  //
  // The OTP row is consumed (deleted) only after the register/login
  // completes successfully, so a username conflict (or any other failure
  // after OTP verify) doesn't force the user to re-request a code.
  async register(body: RegisterInput) {
    // Canonicalise the phone first so the OTP-row lookup, the
    // duplicate-account check, and the eventual create() all read
    // the same E.164 string. A user who typed "0501234567" at OTP
    // send time and "+966 50 123 4567" at register time still
    // resolves to one row. Phone is required even on the email
    // channel because the User schema requires it.
    const phone = normalizePhone(body.phone);
    const code = body.code?.trim();
    const channel: 'phone' | 'email' =
      body.channel === 'email' ? 'email' : 'phone';
    const email = body.email?.trim().toLowerCase() || null;

    if (!phone) {
      throw new BadRequestException('invalid_phone');
    }
    if (!code) {
      throw new BadRequestException('code is required');
    }
    if (channel === 'email' && !email) {
      // Email channel can't verify against an empty target. The
      // frontend should have blocked this client-side, but defend
      // anyway — better a clear 400 than a misleading invalid_code.
      throw new BadRequestException('email is required for email OTP');
    }

    // --- 1. Pick the OTP target for the chosen channel -----------------
    // The Otp row was keyed by the same string OtpService.send wrote:
    // the normalised E.164 phone OR the lowercased email. Using the
    // wrong target here means the verify can never match, even with
    // a real code in hand.
    const otpTarget = channel === 'email' ? email! : phone;

    // --- 2. Server-side OTP verification --------------------------------
    // Same matching rules as OtpService.verify: latest row for this
    // target, equal code, not expired, AND row.type matches the
    // channel. The type check defends against a hypothetical case
    // where the same string (very unlikely for phone vs email) ever
    // appeared as both — we want to honour ONLY the channel the
    // caller proved.
    const otp = await this.prisma.otp.findFirst({
      where: { target: otpTarget, type: channel },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.code !== code) {
      throw new BadRequestException('invalid_code');
    }
    if (otp.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('expired_code');
    }

    // --- 3. Branch on existing-user lookup -----------------------------
    // Look up by the channel that was proven — the user typed an OTP
    // that landed at THIS target, so this target is what they own.
    // For phone-channel, that's the historic behaviour. For
    // email-channel, an existing account with this email logs in
    // even if the body's phone differs (the client may not even have
    // it).
    const existing = await this.prisma.user.findFirst({
      where:
        channel === 'email'
          ? { email: email!, deletedAt: null }
          : { phone, deletedAt: null },
    });

    if (existing) {
      // Login path. Body fields other than the channel+code are
      // intentionally ignored — the client cannot use this endpoint
      // to overwrite an existing account's fullName/email/password.
      await this.prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
      const accessToken = await this.signToken(
        existing.id,
        existing.qiftUsername,
      );
      return {
        accessToken,
        user: this.sanitize(existing),
      };
    }

    // --- 4. Register path ----------------------------------------------
    // Note: `email` was already canonicalised at the top of register()
    // because the email-channel verify step needed it. Re-using that
    // variable here keeps a single source of truth.
    const fullName = body.fullName?.trim() || null;
    const qiftUsername = body.qiftUsername?.trim().toLowerCase();
    const password = body.password;
    const defaultAddress = body.defaultAddress?.trim() || null;

    // Username rules: 3-20 chars, lowercase letters/digits/underscore
    // only. Same regex the public profile route validates against, so
    // a username that creates here will always be reachable at /u/:username.
    // Disallowed: dots (`a.b`), hyphens (`a-b`), Unicode (`نورة`),
    // uppercase (normalized away above but explicit anyway). Min length
    // chosen because <3 chars makes phishing usernames trivial.
    const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
    if (!qiftUsername) {
      throw this.fieldError(
        HttpStatus.BAD_REQUEST,
        'username_required',
        'username is required',
      );
    }
    if (!USERNAME_REGEX.test(qiftUsername)) {
      throw this.fieldError(
        HttpStatus.BAD_REQUEST,
        'username_invalid',
        'username must be 3–20 characters: a-z, 0-9, underscore',
      );
    }
    if (!password || password.length < 8) {
      throw this.fieldError(
        HttpStatus.BAD_REQUEST,
        'password_too_short',
        'password must be at least 8 characters',
      );
    }

    // Uniqueness check. Phone is in the OR list defensively even though
    // the existing-user branch above caught the typical case — a TOCTOU
    // window between that branch and the create() below would otherwise
    // surface as a generic Prisma P2002. We want a clean stable code.
    const conflict = await this.prisma.user.findFirst({
      where: {
        OR: [{ qiftUsername }, ...(email ? [{ email }] : []), { phone }],
      },
      select: { qiftUsername: true, email: true, phone: true },
    });
    if (conflict) {
      // Decide which field collided. Order matters when multiple rows
      // could match — but `findFirst` returns one row, so we just check
      // each field in priority order against the input.
      const code =
        conflict.qiftUsername === qiftUsername
          ? 'username_taken'
          : email && conflict.email === email
            ? 'email_taken'
            : 'phone_taken';
      const message =
        code === 'username_taken'
          ? 'اسم المستخدم محجوز'
          : code === 'email_taken'
            ? 'البريد الإلكتروني مستخدم'
            : 'رقم الهاتف مستخدم';
      throw this.fieldError(HttpStatus.CONFLICT, code, message);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Stamp the verification timestamp ONLY for the channel that was
    // actually proven by the OTP we matched above. A phone-OTP signup
    // proves the phone (phoneVerifiedAt = now); the email is set but
    // unverified (emailVerifiedAt = null). An email-OTP signup is the
    // mirror: emailVerifiedAt = now, phoneVerifiedAt = null. The
    // social-accounts UI reads these timestamps to show a "Verified"
    // chip on the proven channel and an unobtrusive "Verify" prompt
    // on the other.
    const verifiedAt = new Date();
    const user = await this.prisma.user.create({
      data: {
        fullName,
        qiftUsername,
        phone,
        email,
        passwordHash,
        defaultAddress,
        phoneVerifiedAt: channel === 'phone' ? verifiedAt : null,
        emailVerifiedAt: channel === 'email' ? verifiedAt : null,
      },
    });

    // Consume the OTP only after the user row is committed, so a username
    // collision (which throws above) doesn't burn the code.
    await this.prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});

    const accessToken = await this.signToken(user.id, user.qiftUsername);
    return {
      accessToken,
      user: this.sanitize(user),
    };
  }

  async login(body: LoginInput) {
    const identifier = body.identifier?.trim();
    const password = body.password;
    if (!identifier || !password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const lower = identifier.toLowerCase();
    // Week 1 security hardening (F2) — exclude soft-deleted accounts.
    // Soft-deleted users must not be able to obtain a fresh JWT via
    // password login. AdminGuard already rejects soft-deleted users
    // per-request, but blocking at login is the upstream guarantee.
    // The 'Invalid credentials' rejection below matches the
    // wrong-password and unknown-user paths verbatim — a probing
    // attacker cannot distinguish 'account deleted' from 'account
    // never existed' from 'wrong password'.
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ qiftUsername: lower }, { phone: identifier }, { email: lower }],
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.passwordHash) {
      // Legacy users created before password support exists in the schema.
      throw new UnauthorizedException('هذا الحساب يحتاج تعيين كلمة مرور');
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = await this.signToken(user.id, user.qiftUsername);

    return {
      accessToken,
      user: this.sanitize(user),
    };
  }

  private signToken(sub: string, qiftUsername: string) {
    return this.jwtService.signAsync({ sub, qiftUsername });
  }

  // Typed error envelope for the auth flow. Pairs a stable
  // machine-readable `code` with a localized `message`. The frontend
  // switches on `code` (e.g. `username_taken`) to render the right
  // inline field error without parsing localized strings — a pattern
  // already used by /gifts → `recipient_no_default_address`.
  private fieldError(status: HttpStatus, code: string, message: string) {
    return new HttpException({ statusCode: status, code, message }, status);
  }

  private sanitize<T extends { passwordHash?: string | null }>(user: T) {
    const { passwordHash: _omit, ...rest } = user;
    void _omit;
    return rest;
  }
}
