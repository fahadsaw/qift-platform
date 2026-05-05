import {
  Body,
  Controller,
  Get,
  Param,
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
