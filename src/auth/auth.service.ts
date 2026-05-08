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
  // OTP code paired with `phone`. Required for every call. The backend
  // verifies (phone, code) against the Otp table BEFORE issuing any JWT
  // — this is the only credential proving ownership of the phone number.
  code?: string;
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

  // POST /auth/register — register OR login via phone OTP.
  //
  // The endpoint is the only place a JWT can be minted via the OTP path,
  // so OTP verification happens HERE (not on the client). Phone + code
  // are mandatory; everything else is conditional on whether the phone
  // already belongs to a user:
  //
  //   phone exists  → log in. username/email/password from the body are
  //                   IGNORED (we don't trust client-supplied data to
  //                   override existing account fields). JWT for the
  //                   existing user is returned.
  //   phone is new  → register. username + password are required;
  //                   uniqueness is enforced for username/email; a new
  //                   user row is created and a JWT is returned.
  //
  // The OTP row is consumed (deleted) only after the register/login
  // completes successfully, so a username conflict (or any other failure
  // after OTP verify) doesn't force the user to re-request a code.
  async register(body: RegisterInput) {
    // Canonicalise the phone first so the OTP-row lookup, the
    // duplicate-account check, and the eventual create() all read
    // the same E.164 string. A user who typed "0501234567" at OTP
    // send time and "+966 50 123 4567" at register time still
    // resolves to one row.
    const phone = normalizePhone(body.phone);
    const code = body.code?.trim();

    if (!phone) {
      throw new BadRequestException('invalid_phone');
    }
    if (!code) {
      throw new BadRequestException('code is required');
    }

    // --- 1. Server-side OTP verification --------------------------------
    // Same matching rules as OtpService.verify: latest row for this
    // target, equal code, not expired. The OTP is NOT deleted here yet
    // — see the consume step at the bottom of each branch.
    const otp = await this.prisma.otp.findFirst({
      where: { target: phone },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.code !== code) {
      throw new BadRequestException('invalid_code');
    }
    if (otp.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('expired_code');
    }

    // --- 2. Branch on phone existence ----------------------------------
    const existing = await this.prisma.user.findFirst({
      where: { phone, deletedAt: null },
    });

    if (existing) {
      // Login path. Body fields other than phone+code are intentionally
      // ignored — the client cannot use this endpoint to overwrite an
      // existing account's fullName/email/password.
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

    // --- 3. Register path ----------------------------------------------
    const fullName = body.fullName?.trim() || null;
    const qiftUsername = body.qiftUsername?.trim().toLowerCase();
    const email = body.email?.trim().toLowerCase() || null;
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

    const user = await this.prisma.user.create({
      data: {
        fullName,
        qiftUsername,
        phone,
        email,
        passwordHash,
        defaultAddress,
        // Phone is OTP-verified at this point — the only way to reach
        // this `create` is through a successful OTP check above. Stamp
        // phoneVerifiedAt so the social-accounts UI can show a real
        // "Verified" chip without an extra round-trip.
        phoneVerifiedAt: new Date(),
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
    const user = await this.prisma.user.findFirst({
      where: {
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
