// Invitation service — MVP.
//
// Mints + reads + revokes invite tokens. The provider seam is
// handled by `invite-provider.ts`; this service owns the
// persistence layer + privacy + rate-limiting.
//
// SCOPE LIMITS (enforced in code, mirrored in
// project_invitation_architecture.md):
//
//   - NO automated sending. The service mints the token; the
//     SENDER copies the link/message and shares it manually.
//
//   - NO raw channel value persistence. The Invite row stores
//     only the coarse channel + optional platform. The raw
//     phone / email / social handle is NEVER written to the DB.
//     This is the load-bearing privacy invariant against
//     enumeration attacks.
//
//   - NO gift-tied invites yet. The MVP supports general
//     invites only. Gift-tied invites need escrow + hold rules
//     + payment-state machinery that's deferred per the
//     multi-party gifting architecture.
//
//   - NO public-side enumeration. Token resolution returns the
//     minimum payload (isValid + expiresAt). Sender info, channel
//     hint, and platform are NEVER echoed publicly.

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  ManualShareProvider,
  type InviteChannel,
  type InviteSocialPlatform,
  type ManualShareResult,
} from './invite-provider';

// ── Constants ──────────────────────────────────────────────────

// Per-sender daily creation cap. Protects against bulk-spam from a
// compromised account. 20 is calibrated for the MVP — a real
// gifting user mints a handful per day at most; 20 is generous
// without enabling spam runs.
const DAILY_CAP_PER_SENDER = 20;

// Token length in random bytes. 24 bytes = 32 chars base64url.
// More than enough entropy to make guessing infeasible.
const TOKEN_BYTES = 24;

// Default invite TTL. 14 days is long enough for casual gift
// reminders to be acted on but short enough that abandoned
// invites don't pile up. Future gift-tied invites may use a
// shorter window (the gift's payment hold would dominate).
const DEFAULT_TTL_DAYS = 14;

// Valid platform values for `channel='social'`. Mirrors the
// frontend SocialPlatform union. Adding a platform here REQUIRES
// adding it to:
//   1. ManualShareProvider.PLATFORM_OPEN_URL (a safe scheme)
//   2. The frontend search picker
//   3. The runbook coverage for that platform
const VALID_PLATFORMS: ReadonlySet<InviteSocialPlatform> =
  new Set<InviteSocialPlatform>([
    'snapchat',
    'tiktok',
    'instagram',
    'x',
    'facebook',
    'youtube',
    'threads',
    'telegram',
  ]);

// ── Types ──────────────────────────────────────────────────────

export type CreateInviteInput = {
  channel: InviteChannel;
  platform?: InviteSocialPlatform | null;
};

export type CreateInviteResult = {
  id: string;
  token: string;
  inviteUrl: string;
  channel: InviteChannel;
  platform: InviteSocialPlatform | null;
  expiresAt: string;
  suggestedMessage: { ar: string; en: string };
  platformOpenUrl: string | null;
};

// Sender-facing list view of their own invites. Includes status +
// timestamps; does NOT include the raw channel value (we don't
// store it) or any consumed-by user PII beyond their public
// username when present.
export type MyInviteView = {
  id: string;
  token: string;
  channel: InviteChannel;
  platform: InviteSocialPlatform | null;
  status: 'active' | 'expired' | 'revoked' | 'consumed';
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  inviteUrl: string;
};

// Public token-resolution view. Intentionally minimal. The
// landing page renders register/login CTAs and does NOT need
// sender identity to do its job.
export type PublicInviteView = {
  isValid: boolean;
  expiresAt: string | null;
};

// ── Service ────────────────────────────────────────────────────

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);
  private readonly provider = new ManualShareProvider();

  constructor(private prisma: PrismaService) {}

  // Mint a new invite. Enforces rate-limit; generates token;
  // composes manual-share payload via the provider.
  async create(
    senderUserId: string,
    input: CreateInviteInput,
  ): Promise<CreateInviteResult> {
    const channel = validateChannel(input.channel);
    const platform = validatePlatform(channel, input.platform ?? null);

    // Rate-limit. Single COUNT(*) on the per-sender index.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await this.prisma.invite.count({
      where: {
        createdByUserId: senderUserId,
        createdAt: { gte: dayAgo },
      },
    });
    if (recentCount >= DAILY_CAP_PER_SENDER) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'invite_daily_cap_reached',
          message:
            'You have reached the daily invite limit. Try again tomorrow.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(
      Date.now() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const row = await this.prisma.invite.create({
      data: {
        token,
        createdByUserId: senderUserId,
        channel,
        platform,
        expiresAt,
        status: 'active',
      },
      select: {
        id: true,
        token: true,
        channel: true,
        platform: true,
        expiresAt: true,
      },
    });

    const inviteUrl = buildInviteUrl(row.token);
    const manual = this.renderManualShare(
      inviteUrl,
      row.channel as InviteChannel,
      row.platform as InviteSocialPlatform | null,
    );

    this.logger.log(
      `[invites] minted invite id=${row.id} channel=${row.channel} platform=${row.platform ?? '-'} sender=${senderUserId}`,
    );

    return {
      id: row.id,
      token: row.token,
      inviteUrl,
      channel: row.channel as InviteChannel,
      platform: row.platform as InviteSocialPlatform | null,
      expiresAt: row.expiresAt.toISOString(),
      suggestedMessage: manual.suggestedMessage,
      platformOpenUrl: manual.platformOpenUrl,
    };
  }

  // Sender-facing list. Newest first. Returns up to 50; older
  // entries can be retrieved via a future cursor (not needed for
  // MVP — a single sender's invites won't exceed this).
  async listMine(senderUserId: string): Promise<MyInviteView[]> {
    const now = new Date();
    const rows = await this.prisma.invite.findMany({
      where: { createdByUserId: senderUserId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        token: true,
        channel: true,
        platform: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
    return rows.map((r) => {
      // Lazy expired-status. We don't run a cron over the table —
      // the natural-read view simply derives 'expired' when now is
      // past expiresAt and the row hasn't moved to a terminal
      // state.
      const effectiveStatus =
        r.status === 'active' && r.expiresAt < now ? 'expired' : r.status;
      return {
        id: r.id,
        token: r.token,
        channel: r.channel as InviteChannel,
        platform: r.platform as InviteSocialPlatform | null,
        status: effectiveStatus as MyInviteView['status'],
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        consumedAt: r.consumedAt ? r.consumedAt.toISOString() : null,
        inviteUrl: buildInviteUrl(r.token),
      };
    });
  }

  // Sender revokes an active invite. Race-safe: the updateMany
  // re-checks status='active' as a predicate.
  async revoke(
    senderUserId: string,
    id: string,
  ): Promise<{ id: string; status: string }> {
    const row = await this.prisma.invite.findUnique({
      where: { id },
      select: { id: true, createdByUserId: true, status: true },
    });
    if (!row) throw new NotFoundException('Invite not found');
    if (row.createdByUserId !== senderUserId) {
      throw new ForbiddenException('Not your invite');
    }
    if (row.status !== 'active') {
      return { id: row.id, status: row.status };
    }
    const result = await this.prisma.invite.updateMany({
      where: { id, status: 'active' },
      data: { status: 'revoked' },
    });
    if (result.count === 0) {
      // Lost the race — someone else (consume / expiry) just
      // moved it. Return current state.
      const fresh = await this.prisma.invite.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      return {
        id: fresh?.id ?? id,
        status: fresh?.status ?? 'unknown',
      };
    }
    return { id, status: 'revoked' };
  }

  // PUBLIC resolver. NO auth required. Returns the MINIMUM
  // payload the public landing page needs. Never reveals sender
  // identity, channel, or platform.
  //
  // Privacy invariants:
  //   - A non-existent token returns isValid=false WITHOUT
  //     revealing whether the lookup hit a 404 vs. a revoked
  //     row vs. an expired row. The public surface only cares
  //     "can I act on this or not".
  //   - The expiresAt field, when valid, is the only timing
  //     signal exposed — useful for the landing page's "expires
  //     in N days" copy without revealing whether other invites
  //     for this user exist.
  async resolvePublic(token: string): Promise<PublicInviteView> {
    if (!token || token.length < 16 || token.length > 128) {
      return { isValid: false, expiresAt: null };
    }
    const row = await this.prisma.invite.findUnique({
      where: { token },
      select: { status: true, expiresAt: true },
    });
    if (!row) return { isValid: false, expiresAt: null };
    const now = new Date();
    const isValid = row.status === 'active' && row.expiresAt > now;
    return {
      isValid,
      expiresAt: isValid ? row.expiresAt.toISOString() : null,
    };
  }

  // Internal helper exposed for re-rendering a previously-minted
  // invite's manual-share payload (e.g. if the sender lost the
  // copy and wants to re-fetch the message). Routes through the
  // same provider as `create`.
  renderManualShare(
    inviteUrl: string,
    channel: InviteChannel,
    platform: InviteSocialPlatform | null,
  ): ManualShareResult {
    return this.provider.render({ inviteUrl, channel, platform });
  }
}

// ── Helpers ────────────────────────────────────────────────────

function validateChannel(channel: string): InviteChannel {
  if (
    channel === 'phone' ||
    channel === 'email' ||
    channel === 'social' ||
    channel === 'unknown'
  ) {
    return channel;
  }
  throw new BadRequestException('Invalid channel');
}

function validatePlatform(
  channel: InviteChannel,
  platform: string | null,
): InviteSocialPlatform | null {
  if (channel !== 'social') return null;
  if (!platform) {
    throw new BadRequestException('platform required for social channel');
  }
  if (!VALID_PLATFORMS.has(platform as InviteSocialPlatform)) {
    throw new BadRequestException('Unsupported social platform');
  }
  return platform as InviteSocialPlatform;
}

// 24 random bytes → 32-char base64url. URL-safe + no padding.
function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

// Build the public invite URL. The frontend hosts /i/<token>;
// SITE_ORIGIN is operator-configured (falls back to a dev URL).
function buildInviteUrl(token: string): string {
  const origin =
    process.env.QIFT_PUBLIC_SITE_ORIGIN ||
    process.env.NEXT_PUBLIC_SITE_ORIGIN ||
    'https://qift.com.sa';
  return `${origin.replace(/\/$/, '')}/i/${token}`;
}
