import {
  BadRequestException,
  ConflictException,
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
    const phone = body.phone?.trim();
    const code = body.code?.trim();

    if (!phone || phone.length < 6) {
      throw new BadRequestException('phone is required');
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

    if (!qiftUsername || qiftUsername.length < 3) {
      throw new BadRequestException('qiftUsername is required (min 3)');
    }
    if (!password || password.length < 8) {
      throw new BadRequestException('password must be at least 8 characters');
    }

    // Uniqueness for username + email (phone uniqueness is implicit —
    // we know no row exists for this phone, the existing-user branch
    // above caught that case).
    const conflict = await this.prisma.user.findFirst({
      where: {
        OR: [{ qiftUsername }, ...(email ? [{ email }] : [])],
      },
      select: { qiftUsername: true, email: true },
    });
    if (conflict) {
      const field =
        conflict.qiftUsername === qiftUsername ? 'qiftUsername' : 'email';
      throw new ConflictException(`${field} already in use`);
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

  private sanitize<T extends { passwordHash?: string | null }>(user: T) {
    const { passwordHash: _omit, ...rest } = user;
    void _omit;
    return rest;
  }
}
