import {
  Body,
  Controller,
  Get,
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

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// All user routes require authentication. Public account creation belongs on
// `POST /auth/register`, which hashes the password and issues a JWT.
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Post()
  create(@Body() body: Prisma.UserUncheckedCreateInput) {
    return this.usersService.create(body);
  }

  @Get()
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
  @Get('check')
  check(
    @Query('username') username: string,
    @Query('fastCity') fastCity?: string,
  ) {
    return this.usersService.checkByUsername(
      username ?? '',
      fastCity?.trim() || undefined,
    );
  }

  // GET /users/search — real-backend user search. Routed BEFORE the
  // `@/:username` and `:id` routes so the static path doesn't get
  // captured by the parameterised ones. JWT-protected so we never
  // expose this surface anonymously (avoids username/email scraping).
  // See UsersService.searchUsers for the type allow-list, min-length
  // gates, projection rules, and viewer-self exclusion.
  @Get('search')
  search(
    @Query('q') q: string,
    @Query('type') type: string,
    @Req() req: AuthedRequest,
  ) {
    return this.usersService.searchUsers(req.user.userId, q ?? '', type ?? '');
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
  // Privacy gated by showGiftsReceived + profileVisibility (service layer).
  @Get(':userId/gifts/received')
  giftsReceived(@Param('userId') userId: string) {
    return this.usersService.listReceivedGifts(userId);
  }

  // GET /users/:userId/gifts/sent — public sent-gifts list.
  // Privacy gated by showGiftsSent + profileVisibility (service layer).
  @Get(':userId/gifts/sent')
  giftsSent(@Param('userId') userId: string) {
    return this.usersService.listSentGifts(userId);
  }

  // GET /users/:userId/wishes — public wishlist (visibility = 'public').
  // Private accounts return 403 (whole-profile gate).
  @Get(':userId/wishes')
  wishes(@Param('userId') userId: string) {
    return this.usersService.listWishes(userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }
}
