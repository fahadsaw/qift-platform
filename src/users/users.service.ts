import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from '../blocks/blocks.service';
import {
  getDefaultAddressForUser,
  userHasDefaultAddress,
} from '../addresses/default-address.helper';

// Whitelist of fields that are safe to ship over the wire. `passwordHash`
// is never included so it cannot leak through any user endpoint.
const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  qiftUsername: true,
  phone: true,
  email: true,
  defaultAddress: true,
  createdAt: true,
  // Verification timestamps. Null means the channel has not been
  // verified through an OTP / proof-of-ownership flow yet. Set on
  // /auth/register for phone; reset to null when the user changes
  // their email (the new address needs a fresh proof).
  phoneVerifiedAt: true,
  emailVerifiedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private blocks: BlocksService,
  ) {}

  // Canonical username normalisation. Used by every endpoint that looks up
  // a user by qiftUsername — keeping this in one place means callers can't
  // accidentally drift apart on rules.
  //
  //   "  @Sara.M  " → "sara.m"
  //   "@@noura"     → "noura"      (defensive; multiple leading @s)
  //   "  "          → null         (treat as missing)
  //   undefined     → null
  //
  // Trim + strip leading "@" + lowercase. Registration already stores the
  // username in this exact normal form (see AuthService.register) so a
  // direct equality query against the column is safe after this pass.
  private normalizeUsername(raw: string | undefined | null): string | null {
    if (raw == null) return null;
    let s = raw.trim();
    while (s.startsWith('@')) s = s.slice(1);
    s = s.trim().toLowerCase();
    return s.length > 0 ? s : null;
  }

  create(data: Prisma.UserUncheckedCreateInput) {
    return this.prisma.user.create({
      data,
      select: SAFE_USER_SELECT,
    });
  }

  findAll() {
    return this.prisma.user.findMany({
      select: SAFE_USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: SAFE_USER_SELECT,
    });
  }

  findByUsername(qiftUsername: string) {
    return this.prisma.user.findUnique({
      where: { qiftUsername },
      select: SAFE_USER_SELECT,
    });
  }

  // Profile envelope for the authenticated viewer. Bundles the safe user
  // fields with `hasDefaultAddress`, `isSuspended`, the privacy
  // toggles, and the same `stats` block exposed on the public profile
  // — so the self-profile UI can render real follower/following/gift
  // counts without a second round-trip to /users/@/:username. (Before
  // this, /profile rendered mock zeroes while /u/:username rendered
  // the real counts.) Suspension is purely address-derived: no
  // default address ⇒ suspended.
  async getProfile(userId: string) {
    const [user, followersCount, followingCount, giftsSentCount, giftsReceivedCount] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            ...SAFE_USER_SELECT,
            bio: true,
            avatarUrl: true,
            // Privacy toggles surfaced to /settings.
            profileVisibility: true,
            showGiftsReceived: true,
            showGiftsSent: true,
            showFollowers: true,
            showFollowing: true,
            // Wishlist preferences surfaced to /preferences.
            preferredClothingSize: true,
            preferredShoeSize: true,
            preferredRingSize: true,
            preferredPerfume: true,
            favoriteColors: true,
            favoriteCategories: true,
            favoriteBrands: true,
            allergies: true,
            acceptsSurpriseGifts: true,
            addresses: {
              where: { isDefault: true },
              take: 1,
              select: { id: true },
            },
          },
        }),
        // Followers / following exclude soft-deleted accounts on either
        // side so the count matches what the user would actually see if
        // they tapped through to the list.
        this.prisma.follow.count({
          where: {
            followingId: userId,
            status: 'accepted',
            follower: { deletedAt: null },
          },
        }),
        this.prisma.follow.count({
          where: {
            followerId: userId,
            status: 'accepted',
            following: { deletedAt: null },
          },
        }),
        // Cancelled gifts didn't actually happen — exclude from public
        // counts. Same rule applied in getPublicProfile.
        this.prisma.gift.count({
          where: { senderId: userId, status: { not: 'cancelled' } },
        }),
        this.prisma.gift.count({
          where: { receiverId: userId, status: { not: 'cancelled' } },
        }),
      ]);
    if (!user) throw new NotFoundException('User not found');
    const { addresses, ...safe } = user;
    const hasDefaultAddress = addresses.length > 0;
    return {
      ...safe,
      hasDefaultAddress,
      isSuspended: !hasDefaultAddress,
      // Self-view: privacy toggles do NOT redact your own counts —
      // you always see the full picture. Public viewers see the
      // privacy-gated shape via getPublicProfile.
      stats: {
        followers: followersCount,
        following: followingCount,
        giftsSent: giftsSentCount,
        giftsReceived: giftsReceivedCount,
      },
    };
  }

  // PATCH /users/me/profile — update the editable identity fields:
  // display name, bio, and avatar URL. Username + phone + email
  // changes are NOT supported here; those have separate flows
  // (username is set at register, phone is OTP-bound, email is a
  // future verification flow).
  //
  // Validation is conservative: trim each input, drop empties to
  // null, cap lengths to match what the public-profile UI is
  // designed for. avatarUrl must be a parseable absolute URL —
  // we don't do hotlink guarantees yet (that's a CDN-rewrite
  // task), but we reject anything that's plainly not a URL so the
  // public profile doesn't render broken.
  async updateProfile(
    viewerId: string,
    body: {
      fullName?: string | null;
      bio?: string | null;
      avatarUrl?: string | null;
    },
  ) {
    const data: Prisma.UserUpdateInput = {};

    if (body.fullName !== undefined) {
      const v = (body.fullName ?? '').trim();
      if (v.length > 80) {
        throw new BadRequestException('fullName must be at most 80 chars');
      }
      data.fullName = v.length === 0 ? null : v;
    }
    if (body.bio !== undefined) {
      const v = (body.bio ?? '').trim();
      if (v.length > 280) {
        throw new BadRequestException('bio must be at most 280 chars');
      }
      data.bio = v.length === 0 ? null : v;
    }
    if (body.avatarUrl !== undefined) {
      const v = (body.avatarUrl ?? '').trim();
      if (v.length === 0) {
        data.avatarUrl = null;
      } else {
        // Reject anything that doesn't look like an http(s) URL.
        // We don't validate reachability here — the browser's
        // <img> error handler is the authoritative signal at view
        // time and a transient CDN outage shouldn't block edits.
        try {
          const u = new URL(v);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            throw new BadRequestException('avatarUrl must be http(s)');
          }
        } catch {
          throw new BadRequestException('avatarUrl is not a valid URL');
        }
        if (v.length > 1024) {
          throw new BadRequestException('avatarUrl must be at most 1024 chars');
        }
        data.avatarUrl = v;
      }
    }

    if (Object.keys(data).length === 0) return this.getProfile(viewerId);

    await this.prisma.user.update({ where: { id: viewerId }, data });
    return this.getProfile(viewerId);
  }

  // PATCH /users/me/email — set or clear the viewer's email address.
  //
  // Kept separate from updateProfile because email lives on a unique
  // index and merits its own validation/error path (the only way to
  // hit a 409 here is a duplicate-email collision; bundling that into
  // updateProfile blurred the failure semantics).
  //
  // The email is stored UNVERIFIED. We don't have an email-OTP flow
  // yet — when one lands, this endpoint should clear an
  // `emailVerifiedAt` column on update so the next ownership proof
  // re-issues the verification challenge.
  async updateEmail(viewerId: string, body: { email?: string | null }) {
    if (body.email === undefined) return this.getProfile(viewerId);
    const raw = (body.email ?? '').trim();
    if (raw.length === 0) {
      // Clearing the email also clears the verification stamp — the next
      // address (if any) needs its own proof of ownership.
      await this.prisma.user.update({
        where: { id: viewerId },
        data: { email: null, emailVerifiedAt: null },
      });
      return this.getProfile(viewerId);
    }
    // Conservative shape check. Catches typos like missing @ or
    // missing TLD without rejecting valid uncommon shapes (we don't
    // do full RFC 5322 — that's a tarpit). The DB unique index is
    // the authoritative final check.
    const lower = raw.toLowerCase();
    if (lower.length > 254) {
      throw new BadRequestException('email must be at most 254 chars');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
      throw new BadRequestException('email is not a valid address');
    }
    const existing = await this.prisma.user.findFirst({
      where: { email: lower, id: { not: viewerId } },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('email_taken');
    }
    // Read the current email so we only invalidate the verification
    // stamp when the value actually changes — saving the same email
    // twice shouldn't downgrade an OTP-verified account back to
    // unverified.
    const current = await this.prisma.user.findUnique({
      where: { id: viewerId },
      select: { email: true },
    });
    const isChange = (current?.email ?? null) !== lower;
    await this.prisma.user.update({
      where: { id: viewerId },
      data: {
        email: lower,
        ...(isChange ? { emailVerifiedAt: null } : {}),
      },
    });
    return this.getProfile(viewerId);
  }

  // PATCH /users/me/preferences — wishlist preferences MVP. All
  // fields optional, all lengths capped at 200 (seems generous for
  // a size string or comma-separated taste list). Comma-separated
  // strings are a deliberate MVP shape: the future recommender can
  // tokenize on commas without a schema migration.
  async updatePreferences(
    viewerId: string,
    body: {
      preferredClothingSize?: string | null;
      preferredShoeSize?: string | null;
      preferredRingSize?: string | null;
      preferredPerfume?: string | null;
      favoriteColors?: string | null;
      favoriteCategories?: string | null;
      favoriteBrands?: string | null;
      allergies?: string | null;
      acceptsSurpriseGifts?: boolean;
    },
  ) {
    const data: Prisma.UserUpdateInput = {};
    const STR_FIELDS: Array<keyof typeof body> = [
      'preferredClothingSize',
      'preferredShoeSize',
      'preferredRingSize',
      'preferredPerfume',
      'favoriteColors',
      'favoriteCategories',
      'favoriteBrands',
      'allergies',
    ];
    for (const k of STR_FIELDS) {
      const raw = body[k];
      if (raw === undefined) continue;
      if (raw === null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (data as any)[k] = null;
        continue;
      }
      const v = String(raw).trim();
      if (v.length > 200) {
        throw new BadRequestException(`${k} must be at most 200 chars`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data as any)[k] = v.length === 0 ? null : v;
    }
    if (body.acceptsSurpriseGifts !== undefined) {
      data.acceptsSurpriseGifts = body.acceptsSurpriseGifts === true;
    }

    if (Object.keys(data).length === 0) return this.getProfile(viewerId);

    await this.prisma.user.update({ where: { id: viewerId }, data });
    return this.getProfile(viewerId);
  }

  // PATCH /users/me/privacy — update the viewer's privacy toggles.
  //
  // Each field is optional: missing keys keep their current value
  // (PATCH semantics). `profileVisibility` is constrained to the
  // 'public' | 'private' allow-list; the four show* flags are coerced
  // to booleans (truthy → true, falsey → false) so a buggy frontend
  // can't store a non-boolean string.
  //
  // Only the JWT viewer is allowed to call this — enforced at the
  // controller layer via `req.user.userId`. We never accept a userId
  // from the body.
  async updatePrivacy(
    viewerId: string,
    body: {
      profileVisibility?: string;
      showGiftsReceived?: boolean;
      showGiftsSent?: boolean;
      showFollowers?: boolean;
      showFollowing?: boolean;
    },
  ) {
    const data: Prisma.UserUpdateInput = {};

    if (body.profileVisibility !== undefined) {
      const v = String(body.profileVisibility).trim().toLowerCase();
      if (v !== 'public' && v !== 'private') {
        throw new BadRequestException('profileVisibility must be public|private');
      }
      data.profileVisibility = v;
    }
    if (body.showGiftsReceived !== undefined) {
      data.showGiftsReceived = body.showGiftsReceived === true;
    }
    if (body.showGiftsSent !== undefined) {
      data.showGiftsSent = body.showGiftsSent === true;
    }
    if (body.showFollowers !== undefined) {
      data.showFollowers = body.showFollowers === true;
    }
    if (body.showFollowing !== undefined) {
      data.showFollowing = body.showFollowing === true;
    }

    if (Object.keys(data).length === 0) {
      // No-op — return the current state instead of writing nothing.
      return this.getProfile(viewerId);
    }

    await this.prisma.user.update({ where: { id: viewerId }, data });
    return this.getProfile(viewerId);
  }

  // Public-ish lookup used by the /send page to gate the form before any
  // payment is attempted. We deliberately return only the minimum needed
  // for the receiver-card preview — never the phone, email, or any PII.
  //
  // When `fastCity` is provided we ALSO compute `canDeliverFast`: a boolean
  // saying whether the receiver has at least one address in that city. We
  // never return WHICH city matched, the address id, or any other detail.
  // This is the only fast-delivery signal the sender's UI receives.
  // ── User search for the gift-sending flow + the /search page ──────
  // Real backend search across the User table (qift / phone / email)
  // and SocialAccount.handle (every other platform).
  //
  // Return shape is intentionally minimal:
  //   { id, qiftUsername, fullName, avatarUrl, matchedField, matchedValue }
  // We never return phone or email in the payload — even if the search
  // matched on phone, the response surface is still just the public
  // identity (so a successful match doesn't leak which OTHER fields a
  // user has). For social platforms, `matchedValue` IS the handle the
  // user has explicitly published, so returning it is fine.
  //
  // Privacy + safety:
  //   - Soft-deleted users (deletedAt != null) are filtered out.
  //   - The viewer's own row is filtered out — searching for yourself
  //     in a "send a gift" UI is meaningless.
  //   - phone/email require a longer minimum query (5+ chars) to
  //     discourage harvesting; qift/social require just 2.
  //   - Hard cap of 20 rows so a 1-char query can't pull every user.
  //   - Allow-list of accepted `type` values; anything unknown returns
  //     an empty list rather than 500.
  async searchUsers(
    viewerUserId: string,
    q: string,
    type: string,
    dial?: string,
  ) {
    const term = (q ?? '').trim();
    const normType = (type ?? '').trim().toLowerCase();

    // Type allow-list. SOCIAL_TYPES are the platforms backed by the
    // SocialAccount table.
    const SOCIAL_TYPES = new Set([
      'snapchat',
      'tiktok',
      'instagram',
      'x',
      'facebook',
      'youtube',
      'threads',
      'telegram',
    ]);
    const SUPPORTED = new Set([
      'qift',
      'phone',
      'email',
      ...SOCIAL_TYPES,
    ]);
    if (!SUPPORTED.has(normType)) return [];

    // Min-length gate. Phone has its own dedicated path below (exact
    // E.164 match — no partial query is ever accepted). Email keeps
    // the longer prefix so a single-letter "@a" can't enumerate the
    // domain. Username + social handles get the standard 2-char gate.
    if (normType !== 'phone') {
      const minLen = normType === 'email' ? 5 : 2;
      if (term.length < minLen) return [];
    }

    // Common projection — what the search row card actually renders.
    // Selecting this explicitly (vs passing `include`) avoids ever
    // serializing phone/email/passwordHash by accident.
    const PUBLIC_PROJECTION = {
      id: true,
      qiftUsername: true,
      fullName: true,
      avatarUrl: true,
    } as const;

    type SearchRow = {
      id: string;
      qiftUsername: string;
      fullName: string | null;
      avatarUrl: string | null;
      matchedField: string;
      matchedValue: string;
    };

    // Block filter — exclude users I blocked AND users who blocked me.
    // Both directions: a blocked user can't appear in my search and I
    // can't appear in theirs. Loaded once and reused across every type
    // branch so a single search never fans out to N+1 block lookups.
    const excludedIds = await this.blocks.listExcludedIds(viewerUserId);
    const excludedFilter =
      excludedIds.length > 0 ? { notIn: excludedIds } : undefined;

    if (normType === 'qift') {
      const lower = term.toLowerCase();
      const rows = await this.prisma.user.findMany({
        where: {
          deletedAt: null,
          id: { not: viewerUserId, ...(excludedFilter ?? {}) },
          OR: [
            { qiftUsername: { contains: lower, mode: 'insensitive' } },
            { fullName: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: PUBLIC_PROJECTION,
        take: 20,
      });
      return rows.map<SearchRow>((u) => ({
        ...u,
        matchedField: 'qift',
        // matchedValue is the public handle — fine to surface.
        matchedValue: `@${u.qiftUsername}`,
      }));
    }

    if (normType === 'phone') {
      // Phone search is EXACT-match only — never substring. Two
      // accepted query shapes:
      //
      //   1. (preferred) `dial` query param + local digits in `q`.
      //      Frontend's dial-picker uses this. We compose the E.164
      //      from the dial code + normalised local part.
      //   2. `q` already in E.164 form (starts with `+`). Used by
      //      legacy callers and direct API users.
      //
      // Anything else (bare local number without dial, partial
      // digits, country-code-only) returns an empty list. This makes
      // it impossible to enumerate the user table by typing a
      // common prefix and reading off who shows up.
      //
      // After resolving an E.164 candidate, we sanity-check the
      // total length against the stored E.164 format (between 8
      // and 16 digits inclusive of country code) and the SA-specific
      // mobile shape (`+9665XXXXXXXX` — 9 digits after +966 starting
      // with 5). The shape check is intentionally loose for non-SA
      // numbers; we don't have authoritative MSISDN tables for every
      // country, and a stricter check would block legit foreign
      // numbers without protecting privacy.
      const e164 = resolvePhoneE164(term, dial);
      if (!e164) return [];

      const rows = await this.prisma.user.findMany({
        where: {
          deletedAt: null,
          id: { not: viewerUserId, ...(excludedFilter ?? {}) },
          // Stored phones are unique + E.164. Exact match means at
          // most one row — no harvesting possible.
          phone: e164,
          // Per-user phone-discoverability switch. Adds a second
          // privacy gate on top of the exact-match requirement: a
          // user who has opted out is invisible to phone search even
          // if the searcher knows the literal number.
          allowPhoneDiscovery: true,
          // Profile visibility = 'private' accounts are also hidden
          // from phone search. They can still be reached by the
          // people they explicitly follow / are followed by, via the
          // username path.
          profileVisibility: { not: 'private' },
        },
        select: PUBLIC_PROJECTION,
        take: 1,
      });
      // matchedValue intentionally generic — we don't echo phone back.
      return rows.map<SearchRow>((u) => ({
        ...u,
        matchedField: 'phone',
        matchedValue: '',
      }));
    }

    if (normType === 'email') {
      const rows = await this.prisma.user.findMany({
        where: {
          deletedAt: null,
          id: { not: viewerUserId, ...(excludedFilter ?? {}) },
          email: { contains: term, mode: 'insensitive' },
        },
        select: PUBLIC_PROJECTION,
        take: 20,
      });
      return rows.map<SearchRow>((u) => ({
        ...u,
        matchedField: 'email',
        matchedValue: '',
      }));
    }

    // Social platform — search the SocialAccount table for matching
    // handles on this platform, then resolve back to the owner.
    const accounts = await this.prisma.socialAccount.findMany({
      where: {
        platform: normType,
        handle: { contains: term, mode: 'insensitive' },
        user: { deletedAt: null },
        userId: { not: viewerUserId, ...(excludedFilter ?? {}) },
      },
      select: {
        platform: true,
        handle: true,
        user: { select: PUBLIC_PROJECTION },
      },
      take: 20,
    });
    return accounts.map<SearchRow>((a) => ({
      ...a.user,
      matchedField: a.platform,
      // Social handles are explicitly published by the user — safe to
      // surface so the searcher can confirm they found the right person.
      matchedValue: `@${a.handle}`,
    }));
  }

  async checkByUsername(qiftUsername: string, fastCity?: string) {
    const username = this.normalizeUsername(qiftUsername);
    if (!username) {
      return {
        exists: false as const,
        hasDefaultAddress: false,
        canDeliverFast: fastCity ? false : null,
      };
    }
    // Soft-deleted accounts shouldn't show up to senders — they can't
    // receive gifts anyway. The previous query missed this filter,
    // which would have returned a stale result for a deleted user.
    const user = await this.prisma.user.findFirst({
      where: { qiftUsername: username, deletedAt: null },
      select: {
        id: true,
        qiftUsername: true,
        fullName: true,
      },
    });
    if (!user) {
      return {
        exists: false as const,
        hasDefaultAddress: false,
        canDeliverFast: fastCity ? false : null,
      };
    }
    // Canonical default-address resolver. Every other gift-flow caller
    // routes through the same helper so a future rule change (e.g.
    // soft-deleted addresses, regional gating) lands in one place.
    const hasDefaultAddress = await userHasDefaultAddress(
      this.prisma,
      user.id,
    );
    const canDeliverFast = fastCity
      ? await this.canDeliverFast(user.id, fastCity)
      : null;
    if (process.env.GIFT_FLOW_DEBUG === '1') {
      this.logger.log(
        `[gift-flow] checkByUsername username="${username}" userId=${user.id} hasDefaultAddress=${hasDefaultAddress} fastCity=${fastCity ?? '-'} canDeliverFast=${canDeliverFast}`,
      );
    }
    return {
      exists: true as const,
      qiftUsername: user.qiftUsername,
      fullName: user.fullName,
      hasDefaultAddress,
      // `null` when no fastCity was supplied — the UI uses `null` as the
      // "this product isn't fast delivery, ignore the field" signal.
      canDeliverFast,
    };
  }

  // GET /users/@/:username — public profile lookup.
  //
  // Privacy is enforced here, not at the schema layer: the response only
  // contains fields the viewer is allowed to see, and stats counts for
  // disabled visibility flags are simply not included. The frontend
  // distinguishes "hidden" from "zero" by field presence ("if 'followers'
  // in stats" vs falling back).
  //
  // Self-viewing produces isFollowing=false and isFollowedBy=false naturally
  // (no Follow row exists where followerId === followingId — that's also
  // blocked by the FollowsService self-check). Self-viewing of one's own
  // *private* account still returns the limited shape; the owner's full
  // self-view lives at GET /users/me.
  async getPublicProfile(viewerId: string, rawUsername: string) {
    this.logger.log(
      `getPublicProfile: incoming raw username=${JSON.stringify(rawUsername)}`,
    );
    const username = this.normalizeUsername(rawUsername);
    this.logger.log(
      `getPublicProfile: normalized username=${JSON.stringify(username)}`,
    );

    if (!username) {
      this.logger.warn('getPublicProfile: empty after normalisation → 404');
      throw new NotFoundException('user_not_found');
    }

    const user = await this.prisma.user.findFirst({
      where: { qiftUsername: username, deletedAt: null },
      select: {
        id: true,
        fullName: true,
        qiftUsername: true,
        bio: true,
        avatarUrl: true,
        profileVisibility: true,
        showFollowers: true,
        showFollowing: true,
        showGiftsSent: true,
        showGiftsReceived: true,
      },
    });
    this.logger.log(
      `getPublicProfile: db match for "${username}" → ${user ? `user ${user.id}` : 'none'}`,
    );
    if (!user) throw new NotFoundException('user_not_found');

    const isPrivate = user.profileVisibility === 'private';

    // Skip count queries entirely for stats the viewer can't see — saves
    // both the round-trip and the chance of leakage via server-side logs.
    const wantFollowers = !isPrivate && user.showFollowers;
    const wantFollowing = !isPrivate && user.showFollowing;
    const wantGiftsSent = !isPrivate && user.showGiftsSent;
    const wantGiftsReceived = !isPrivate && user.showGiftsReceived;

    const [
      followingRow,
      followedByRow,
      followersCount,
      followingCount,
      giftsSentCount,
      giftsReceivedCount,
    ] = await Promise.all([
      // isFollowing — does the viewer follow this user
      this.prisma.follow.findFirst({
        where: {
          followerId: viewerId,
          followingId: user.id,
          status: 'accepted',
        },
        select: { followerId: true },
      }),
      // isFollowedBy — does this user follow the viewer
      this.prisma.follow.findFirst({
        where: {
          followerId: user.id,
          followingId: viewerId,
          status: 'accepted',
        },
        select: { followerId: true },
      }),
      wantFollowers
        ? this.prisma.follow.count({
            where: {
              followingId: user.id,
              status: 'accepted',
              follower: { deletedAt: null },
            },
          })
        : Promise.resolve(undefined),
      wantFollowing
        ? this.prisma.follow.count({
            where: {
              followerId: user.id,
              status: 'accepted',
              following: { deletedAt: null },
            },
          })
        : Promise.resolve(undefined),
      wantGiftsSent
        ? this.prisma.gift.count({
            where: {
              senderId: user.id,
              // Cancelled gifts didn't actually happen — exclude from public
              // counts. Status enum lives as String in the schema; allowed
              // values are documented on Gift.status.
              status: { not: 'cancelled' },
            },
          })
        : Promise.resolve(undefined),
      wantGiftsReceived
        ? this.prisma.gift.count({
            where: {
              receiverId: user.id,
              status: { not: 'cancelled' },
            },
          })
        : Promise.resolve(undefined),
    ]);

    const isFollowing = !!followingRow;
    const isFollowedBy = !!followedByRow;

    if (isPrivate) {
      // Limited shape. Bio and stats are deliberately omitted, regardless
      // of show* flags — those flags only apply to public profiles.
      return {
        id: user.id,
        fullName: user.fullName,
        qiftUsername: user.qiftUsername,
        avatarUrl: user.avatarUrl,
        profileVisibility: user.profileVisibility,
        isFollowing,
        isFollowedBy,
      };
    }

    // Public shape — privacy-gated stats. Each stat key is only present
    // when the corresponding show* flag is true.
    const stats: {
      followers?: number;
      following?: number;
      giftsSent?: number;
      giftsReceived?: number;
    } = {};
    if (followersCount !== undefined) stats.followers = followersCount;
    if (followingCount !== undefined) stats.following = followingCount;
    if (giftsSentCount !== undefined) stats.giftsSent = giftsSentCount;
    if (giftsReceivedCount !== undefined)
      stats.giftsReceived = giftsReceivedCount;

    return {
      id: user.id,
      fullName: user.fullName,
      qiftUsername: user.qiftUsername,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      profileVisibility: user.profileVisibility,
      stats,
      isFollowing,
      isFollowedBy,
    };
  }

  // Loads the target user for the per-user list endpoints below, with the
  // privacy fields the caller needs to gate access. Throws 404 for missing
  // or soft-deleted users so callers can't probe deletion.
  private async loadTargetWithFlags(userId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        profileVisibility: true,
        showGiftsReceived: true,
        showGiftsSent: true,
      },
    });
    if (!target) throw new NotFoundException('user_not_found');
    return target;
  }

  // GET /users/:userId/gifts/received — public received-gifts list.
  //
  // Privacy: gated by both `showGiftsReceived` AND profileVisibility !==
  // 'private'. Mirroring how getPublicProfile hides stats for private
  // accounts — we don't want a private account's gift history to be
  // browsable just because the granular flag was left on.
  //
  // Field surface: deliberately narrow. Excludes messageText, mediaUrl,
  // mediaType, addressId, tracking fields — those are private-by-default
  // on the Gift model. `otherUser` is the sender, masked entirely (set to
  // null) when the gift is anonymous.
  //
  // Cancelled gifts and gifts whose sender has been soft-deleted are
  // dropped. Newest first.
  async listReceivedGifts(targetUserId: string) {
    const target = await this.loadTargetWithFlags(targetUserId);
    if (target.profileVisibility === 'private' || !target.showGiftsReceived) {
      throw new ForbiddenException('gifts_received_hidden');
    }

    const gifts = await this.prisma.gift.findMany({
      where: {
        receiverId: targetUserId,
        status: { not: 'cancelled' },
        // Anonymous gifts are kept; non-anonymous ones must have a live sender.
        OR: [{ isAnonymous: true }, { sender: { deletedAt: null } }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        productName: true,
        storeName: true,
        isAnonymous: true,
        createdAt: true,
        sender: {
          select: {
            id: true,
            fullName: true,
            qiftUsername: true,
            avatarUrl: true,
          },
        },
      },
    });

    const items = gifts.map((g) => ({
      id: g.id,
      productName: g.productName,
      storeName: g.storeName,
      isAnonymous: g.isAnonymous,
      createdAt: g.createdAt,
      // Anonymous → drop sender entirely. Frontend renders "Sent anonymously"
      // and shows no avatar / username for these rows.
      otherUser: g.isAnonymous ? null : g.sender,
    }));

    return { items, total: items.length };
  }

  // GET /users/:userId/gifts/sent — public sent-gifts list.
  //
  // Privacy: gated by both `showGiftsSent` AND profileVisibility !==
  // 'private'. `isAnonymous` on a sent row is informational only — the
  // sender (this profile) is the same as the target, so identity isn't
  // hidden. The receiver is always shown.
  //
  // Same field-surface narrowing as listReceivedGifts. Cancelled and
  // dead-receiver rows are dropped.
  async listSentGifts(targetUserId: string) {
    const target = await this.loadTargetWithFlags(targetUserId);
    if (target.profileVisibility === 'private' || !target.showGiftsSent) {
      throw new ForbiddenException('gifts_sent_hidden');
    }

    const gifts = await this.prisma.gift.findMany({
      where: {
        senderId: targetUserId,
        status: { not: 'cancelled' },
        receiver: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        productName: true,
        storeName: true,
        isAnonymous: true,
        createdAt: true,
        receiver: {
          select: {
            id: true,
            fullName: true,
            qiftUsername: true,
            avatarUrl: true,
          },
        },
      },
    });

    const items = gifts.map((g) => ({
      id: g.id,
      productName: g.productName,
      storeName: g.storeName,
      isAnonymous: g.isAnonymous,
      createdAt: g.createdAt,
      otherUser: g.receiver,
    }));

    return { items, total: items.length };
  }

  // GET /users/:userId/wishes — public wishlist.
  //
  // Privacy: gated by profileVisibility !== 'private' (no per-user wish
  // privacy flag — only per-row Wish.visibility). Private accounts hide
  // all wishes regardless of per-row visibility, matching the gift list
  // semantics above.
  //
  // Returns only Wish rows with visibility = 'public'. Per-row private
  // wishes are owner-visible only and would be served by a separate
  // /users/me/wishes endpoint when that lands.
  async listWishes(targetUserId: string) {
    const target = await this.loadTargetWithFlags(targetUserId);
    if (target.profileVisibility === 'private') {
      throw new ForbiddenException('wishes_hidden');
    }

    const wishes = await this.prisma.wish.findMany({
      where: {
        userId: targetUserId,
        visibility: 'public',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        store: true,
        createdAt: true,
      },
    });

    return { items: wishes, total: wishes.length };
  }

  // Privacy-preserving city-match check for fast-delivery products.
  //
  // Returns ONLY a boolean. We never expose the matching address, the
  // receiver's other cities, the count of matches, or anything else — the
  // sender already knows the store's city, so the only new bit of info
  // they learn is "yes/no, this gift can be delivered". That's the same
  // information surface as `hasDefaultAddress`.
  //
  // Matching is case-insensitive and trim-tolerant. We use Prisma's `equals`
  // with a normalised value so SQLite's default collation doesn't trip us up
  // on Arabic strings.
  async canDeliverFast(
    receiverId: string,
    storeCity: string,
  ): Promise<boolean> {
    const city = storeCity.trim();
    if (!city) return false;
    // Pull only the city field for the receiver's addresses, then compare
    // in JS so we get reliable Arabic case/space normalisation. We never
    // return these values to the caller — they stay inside the function.
    const rows = await this.prisma.address.findMany({
      where: { userId: receiverId },
      select: { city: true },
    });
    const target = normaliseCity(city);
    return rows.some((row) => normaliseCity(row.city) === target);
  }
}

// Lower-case, collapse whitespace, strip Arabic diacritics so that
// "الرياض  " matches "الرياض" matches "ٱلرياض". Same algorithm has to be
// used on both sides of the equality check.
function normaliseCity(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Per-country mobile-MSISDN length. The number stored in `User.phone`
// is the E.164 form `+<dial><local>`, so the total digit count we
// expect for a complete record is `dial.length + local`. Loose by
// design — we only encode shapes we're confident about; everything
// else falls back to the generic E.164 7..15 digit range.
const COUNTRY_LOCAL_LENGTHS: Record<string, number> = {
  '966': 9, // Saudi Arabia: 5XXXXXXXX
  '971': 9, // UAE
  '965': 8, // Kuwait
  '974': 8, // Qatar
  '973': 8, // Bahrain
  '968': 8, // Oman
};

// Saudi-specific extra rule: mobile numbers MUST start with 5 after
// the country code. Encoded separately from the length table because
// it's a digit-prefix check, not a length check.
const SA_MOBILE_PREFIX = /^\+9665\d{8}$/;

// Resolve a (q, dial) pair into a fully-qualified E.164 phone string,
// returning `null` whenever the input isn't complete enough to do an
// exact-match lookup. This is the core privacy gate: any path that
// could produce a partial query exits with `null` so the search
// returns zero rows rather than substring-matching the user table.
//
// Accepted inputs:
//   - dial="+966", q="0501234567" → "+966501234567"
//   - dial="+966", q="501234567"  → "+966501234567"
//   - dial="+966", q="+966501234567" → ignored dial; uses q as-is
//   - dial="",     q="+966501234567" → "+966501234567"
//   - dial="",     q="0501234567"    → null (no country context)
//   - dial="+966", q="555"           → null (incomplete local)
export function resolvePhoneE164(
  q: string,
  dial: string | undefined,
): string | null {
  const term = (q ?? '').trim();
  const dialTrim = (dial ?? '').trim();

  // Build a candidate E.164 string.
  let candidate: string | null = null;
  if (term.startsWith('+')) {
    // Caller supplied a full E.164 — use it directly. We strip non-
    // digits from the local portion (spaces, dashes, parens) but
    // KEEP the leading `+` because it's the marker that this is a
    // complete number.
    const cleaned = '+' + term.slice(1).replace(/\D+/g, '');
    candidate = cleaned;
  } else if (dialTrim) {
    // Compose dial + local. Strip non-digits + leading zeros from the
    // local part — Saudis often paste `0501234567`; that leading 0
    // must die before concatenation.
    const dialWithPlus = dialTrim.startsWith('+') ? dialTrim : `+${dialTrim}`;
    const localDigits = term.replace(/\D+/g, '').replace(/^0+/, '');
    if (!localDigits) return null;
    candidate = `${dialWithPlus}${localDigits}`;
  } else {
    // No dial AND no leading `+` — we can't tell which country this
    // belongs to. Refuse the query rather than guess.
    return null;
  }

  // Sanity-check shape against the E.164 envelope.
  if (!/^\+[1-9]\d{6,14}$/.test(candidate)) return null;

  // Country-aware completeness. Pull the dial code by trying the
  // longest known prefix first (3 then 2 then 1 digit) — we don't
  // have a full country-code table, but COUNTRY_LOCAL_LENGTHS covers
  // the GCC where we have authoritative shape rules.
  const digits = candidate.slice(1); // drop the +
  for (const dialCode of Object.keys(COUNTRY_LOCAL_LENGTHS)) {
    if (digits.startsWith(dialCode)) {
      const expectedLocal = COUNTRY_LOCAL_LENGTHS[dialCode];
      const localLen = digits.length - dialCode.length;
      if (localLen !== expectedLocal) return null;
      // Saudi extra rule.
      if (dialCode === '966' && !SA_MOBILE_PREFIX.test(candidate)) {
        return null;
      }
      return candidate;
    }
  }

  // Unknown country code — fall back to a permissive 7..15-digit
  // total length (E.164 envelope) so legitimate foreign numbers
  // still resolve. The exact-match `phone: equals` filter at the
  // call site means a too-short or too-long candidate just returns
  // zero rows; the only privacy concern is enumeration via partial
  // matching, which we already prevented above.
  if (digits.length < 7 || digits.length > 15) return null;
  return candidate;
}
