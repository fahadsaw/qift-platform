import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../admin/admin.guard';
import { RateLimiter } from '../common/rate-limiter';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Per-viewer rate limit for the contact-channel branches of
// `/users/search` (phone + email — the two surfaces where each query
// reveals an exact contact-record hit). 30 attempts per 5 minutes is
// generous for legitimate use (the frontend only fires once per
// "Search" button click) but throttles a script trying to brute-force
// through a list. Username + social-handle searches are unrestricted
// — those handles are explicitly published by the user.
const contactSearchLimiter = new RateLimiter(30, 5 * 60 * 1000);

// All user routes require authentication. Public account creation belongs on
// `POST /auth/register`, which hashes the password and issues a JWT.
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  // Direct admin-only "create a user row" — bypasses the OTP-bound
  // /auth/register flow. Locked behind AdminGuard since (1) the body
  // is the raw Prisma type and a non-admin caller could set arbitrary
  // fields (incl. role='admin'), and (2) registration is the
  // canonical user-creation path. Kept for one-off admin tooling.
  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@Body() body: Prisma.UserUncheckedCreateInput) {
    return this.usersService.create(body);
  }

  // Admin-only enumeration. The response includes phone + email +
  // defaultAddress (SAFE_USER_SELECT for ALL users) — a non-admin
  // caller could scrape the entire user table in one request. Gate
  // strictly. Public look-ups go through /users/@/:username (returns
  // the privacy-projected PublicProfile) or /users/check (returns
  // the narrow recipient-confirmation shape).
  @Get()
  @UseGuards(JwtAuthGuard, AdminGuard)
  findAll() {
    return this.usersService.findAll();
  }

  // Profile envelope for the logged-in viewer. Includes `isSuspended` and
  // `hasDefaultAddress` so the UI can render the suspension banner in one
  // round-trip.
  @Get('me')
  me(@Req() req: AuthedRequest) {
    return this.usersService.getProfile(req.user.userId);
  }

  // PATCH /users/me/privacy — update the viewer's privacy toggles.
  // Body fields are all optional (PATCH semantics); see
  // UsersService.updatePrivacy for the allow-list + coercion rules.
  // Returns the same envelope as GET /users/me so the settings UI can
  // re-hydrate without a follow-up call.
  @Patch('me/privacy')
  updatePrivacy(
    @Body()
    body: {
      profileVisibility?: string;
      showGiftsReceived?: boolean;
      showGiftsSent?: boolean;
      showFollowers?: boolean;
      showFollowing?: boolean;
      // QA audit follow-up — explicit contact-channel
      // discoverability switches surfaced to /settings.
      allowPhoneDiscovery?: boolean;
      allowEmailDiscovery?: boolean;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.updatePrivacy(req.user.userId, body);
  }

  // PATCH /users/me/profile — edit display name, bio, avatar URL.
  // Username/phone/email are intentionally NOT editable here (they
  // have their own auth-bound flows). See UsersService.updateProfile
  // for the validation rules.
  @Patch('me/profile')
  updateProfile(
    @Body()
    body: {
      fullName?: string | null;
      bio?: string | null;
      avatarUrl?: string | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.updateProfile(req.user.userId, body);
  }

  // POST /users/me/change-phone/start — begin the OTP-verified phone
  // change (PR 5). Validates + uniqueness pre-checks the new number,
  // then dispatches an OTP to it via the shared OtpService. Errors:
  // 400 invalid_phone / phone_unchanged, 409 phone_taken, plus the
  // OtpService send errors (otp_rate_limited, sms_unavailable).
  @Post('me/change-phone/start')
  changePhoneStart(
    @Body() body: { newPhone?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.changePhoneStart(req.user.userId, body.newPhone);
  }

  // POST /users/me/change-phone/confirm — verify the code that
  // arrived on the NEW number and commit the change. Errors: the
  // start-step set plus invalid_code / expired_code / otp_locked.
  // Returns the /users/me envelope so settings re-hydrates in one
  // round-trip.
  @Post('me/change-phone/confirm')
  changePhoneConfirm(
    @Body() body: { newPhone?: string; code?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.changePhoneConfirm(
      req.user.userId,
      body.newPhone,
      body.code,
    );
  }

  // POST /users/me/change-email/start — begin the OTP-verified email
  // change (PR 6, mirror of change-phone). Errors: 400 invalid_email
  // / email_unchanged, 409 email_taken, plus OtpService send errors
  // (otp_rate_limited, email_unavailable).
  @Post('me/change-email/start')
  changeEmailStart(
    @Body() body: { newEmail?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.changeEmailStart(req.user.userId, body.newEmail);
  }

  // POST /users/me/change-email/confirm — verify the code that
  // arrived at the NEW address and commit; stamps emailVerifiedAt.
  @Post('me/change-email/confirm')
  changeEmailConfirm(
    @Body() body: { newEmail?: string; code?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.changeEmailConfirm(
      req.user.userId,
      body.newEmail,
      body.code,
    );
  }

  // PATCH /users/me/email — set or clear the viewer's email address.
  // Stored UNVERIFIED; the OTP-verified path is
  // POST /users/me/change-email/* above (PR 6). This legacy route
  // stays for the social-accounts surface and for clearing the
  // address. Returns the same /users/me envelope so the
  // social-accounts page can re-hydrate without a follow-up call.
  @Patch('me/email')
  updateEmail(
    @Body() body: { email?: string | null },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.updateEmail(req.user.userId, body);
  }

  // PATCH /users/me/preferences — wishlist preferences MVP.
  // All fields optional; nullable strings; one boolean for the
  // accepts-surprise toggle.
  @Patch('me/preferences')
  updatePreferences(
    @Body()
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
      // Free-text note (≤ 280 chars). Plain text only.
      giftNote?: string | null;
      // Per-field publicity for the public profile preferences
      // section. Service-side filtered to a known-key allow-list.
      preferencesVisibility?: Record<string, boolean> | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.updatePreferences(req.user.userId, body);
  }

  // Lightweight receiver-existence + address gate, used by /send to decide
  // whether to show the red-username warning before any payment intent. JWT
  // is required so we don't expose username enumeration to anonymous traffic.
  //
  // Optional `fastCity` query param turns this into the fast-delivery probe
  // as well: the response then carries a privacy-safe `canDeliverFast`
  // boolean (true when the receiver has *any* address in that city). We
  // never echo the city back, so a sender can't enumerate whether multiple
  // candidate cities matched — they only learn yes/no for the city THEY
  // already know about (the store's city).
  //
  // Optional `storeId` upgrades the probe to full coverage matching:
  // we look up the store's `deliveryZones` and check every receiver
  // address against the same matcher GiftsService.confirmAddress
  // uses. This catches the district-restricted case (Riyadh-flowers
  // merchant covering only 9 northern districts) — a city-only check
  // would say "yes Riyadh works" and let the buyer pay, then the
  // confirm-address step would reject. Privacy unchanged: the
  // response is still just the boolean, never the address detail.
  @Get('check')
  check(
    @Query('username') username: string,
    @Query('fastCity') fastCity?: string,
    @Query('storeId') storeId?: string,
  ) {
    return this.usersService.checkByUsername(
      username ?? '',
      fastCity?.trim() || undefined,
      storeId?.trim() || undefined,
    );
  }

  // GET /users/search — real-backend user search. Routed BEFORE the
  // `@/:username` and `:id` routes so the static path doesn't get
  // captured by the parameterised ones. JWT-protected so we never
  // expose this surface anonymously (avoids username/email scraping).
  // See UsersService.searchUsers for the type allow-list, min-length
  // gates, projection rules, and viewer-self exclusion.
  //
  // The optional `dial` query param scopes a phone search to a
  // specific country code (e.g. `dial=+966`) so the frontend can
  // submit a local-format number (`5XXXXXXXX` / `0501234567`) without
  // burning the privacy gate. See UsersService.resolvePhoneE164 for
  // the canonicalisation rules.
  //
  // Rate limit: phone + email search attempts are throttled per-viewer
  // (30 / 5 min). Other types (username, social handles) bypass it —
  // social handles are published by the user, and username search is
  // the primary discovery flow.
  @Get('search')
  search(
    @Query('q') q: string,
    @Query('type') type: string,
    @Query('dial') dial: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    const normType = (type ?? '').trim().toLowerCase();
    if (normType === 'phone' || normType === 'email') {
      const ok = contactSearchLimiter.hit(`contact:${req.user.userId}`);
      if (!ok) {
        // 429 with a stable `code` so the frontend can surface a
        // friendly "try again in a moment" toast without parsing the
        // localised message string.
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            code: 'search_rate_limited',
            message: 'Too many search attempts. Try again in a few minutes.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return this.usersService.searchUsers(
      req.user.userId,
      q ?? '',
      type ?? '',
      dial,
    );
  }

  // GET /users/@/:username — public profile by username, privacy-aware.
  // Auth-protected to match the rest of /users/* and so that the viewer
  // identity is available for computing isFollowing / isFollowedBy. The
  // service enforces field-level privacy and 404s on unknown / soft-deleted
  // accounts.
  @Get('@/:username')
  publicProfile(
    @Param('username') username: string,
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.getPublicProfile(req.user.userId, username);
  }

  // GET /users/:userId/gifts/received — public received-gifts list.
  // Privacy gated by showGiftsReceived + profileVisibility + block
  // list (service layer).
  @Get(':userId/gifts/received')
  giftsReceived(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.usersService.listReceivedGifts(req.user.userId, userId);
  }

  // GET /users/:userId/gifts/sent — public sent-gifts list.
  // Privacy gated by showGiftsSent + profileVisibility + block list.
  @Get(':userId/gifts/sent')
  giftsSent(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.usersService.listSentGifts(req.user.userId, userId);
  }

  // GET /users/:userId/wishes — public wishlist (visibility = 'public').
  // Private accounts return 403 (whole-profile gate). Block list
  // returns 404 (same shape as "user not found" — never leaks the
  // existence of the block).
  @Get(':userId/wishes')
  wishes(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.usersService.listWishes(req.user.userId, userId);
  }

  // Admin-only lookup by id. Returns the SAFE_USER_SELECT shape
  // which includes phone + email + defaultAddress — these MUST NOT
  // be exposed to non-admins. Public-facing "look this user up"
  // surfaces:
  //   - GET /users/@/:username  → privacy-projected PublicProfile
  //   - GET /users/check         → narrow recipient-confirmation
  //   - GET /users/search        → username / handle / phone with
  //                                the discoverability gates
  @Get(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }
}
