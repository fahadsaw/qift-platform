import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  WishesService,
  type CreateWishInput,
  type UpdateWishInput,
} from './wishes.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Routes:
//   POST   /wishes                       — create or upsert a wish.
//   GET    /wishes/me                    — viewer's full wishlist (public + private).
//   GET    /wishes/check?productId=…     — "is this product in my wishlist?"
//   PATCH  /wishes/:id                   — update one wish (legacy fields).
//   DELETE /wishes/:id                   — delete a specific wish.
//   DELETE /wishes/by-product/:productId — unheart by product id (no wish-id lookup).
//
// Public-profile reads still live on UsersController as
// `GET /users/:userId/wishes` (privacy-gated, public-only).
//
// Route order: literal segments (`me`, `check`, `by-product`) MUST
// come before the parametric `:id` so the literal wins the match.
@Controller('wishes')
@UseGuards(JwtAuthGuard)
export class WishesController {
  constructor(private service: WishesService) {}

  @Post()
  create(@Body() body: CreateWishInput, @Req() req: AuthedRequest) {
    return this.service.create(req.user.userId, body);
  }

  @Get('me')
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user.userId);
  }

  // Lightweight heart-state probe used by every surface that
  // renders a ❤️ button. Drives the filled-vs-outline state without
  // requiring the full wishlist payload.
  @Get('check')
  check(
    @Query('productId') productId: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.service.checkMembership(req.user.userId, productId ?? '');
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateWishInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.update(req.user.userId, id, body);
  }

  // Symmetric unheart endpoint — the frontend doesn't have to
  // round-trip for the wish id before deleting. Idempotent: if the
  // product isn't wishlisted, returns ok without error so the
  // optimistic local state stays consistent.
  @Delete('by-product/:productId')
  removeByProduct(
    @Param('productId') productId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.service.removeByProduct(req.user.userId, productId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.remove(req.user.userId, id);
  }
}
