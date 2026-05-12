import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { GiftPostsService, type PublishInput } from './gift-posts.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };
type OptionallyAuthedRequest = {
  user?: { userId: string; qiftUsername: string };
};

// Routes:
//   POST   /gift-posts/publish              — publish (or republish) a gift.
//                                              Body: { giftId, visibility? }
//   POST   /gift-posts/:id/unpublish        — owner pulls back to private.
//   POST   /gift-posts/:id/visibility       — toggle 'private' | 'public'.
//   POST   /gift-posts/:id/appreciate       — 👍 toggle.
//   GET    /gift-posts/:id/appreciation     — membership probe for button.
//   GET    /gift-posts/mine                 — owner's full wall.
//   GET    /gift-posts/by-user/:userId      — public Gift Wall for a user.
//   GET    /gift-posts/by-slug/:slug        — /p/<slug> public route.
//
// Route order: literal segments come before parametric `:id` so the
// literal wins the match (same pattern as WishesController).
@Controller('gift-posts')
export class GiftPostsController {
  constructor(private service: GiftPostsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('publish')
  publish(@Body() body: PublishInput, @Req() req: AuthedRequest) {
    return this.service.publish(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user.userId);
  }

  // Caller-owned lookup by source gift. Used by the gift-detail
  // publish card to pre-populate state without scanning the whole
  // wall. Returns the raw row (or null) — the wall view shape is
  // not relevant here since the caller already has the gift context.
  @UseGuards(JwtAuthGuard)
  @Get('by-gift/:giftId')
  getMineByGift(@Param('giftId') giftId: string, @Req() req: AuthedRequest) {
    return this.service.getMineByGift(req.user.userId, giftId);
  }

  // Public read — supports anonymous viewers. We accept an optional
  // JWT so an authenticated owner sees the same shape an anonymous
  // viewer would, keeping the privacy semantics consistent across
  // both call sites.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('by-user/:userId')
  listByUser(
    @Param('userId') userId: string,
    @Req() req: OptionallyAuthedRequest,
  ) {
    return this.service.listByUser(userId, req.user?.userId ?? null);
  }

  // Public read — anonymous viewers welcome.
  @UseGuards(OptionalJwtAuthGuard)
  @Get('by-slug/:slug')
  getBySlug(@Param('slug') slug: string, @Req() req: OptionallyAuthedRequest) {
    return this.service.getBySlug(slug, req.user?.userId ?? null);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/unpublish')
  unpublish(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.unpublish(req.user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/visibility')
  setVisibility(
    @Param('id') id: string,
    @Body() body: { visibility: 'private' | 'public' },
    @Req() req: AuthedRequest,
  ) {
    return this.service.setVisibility(req.user.userId, id, body.visibility);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/appreciate')
  appreciate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.appreciate(req.user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/appreciation')
  checkAppreciation(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.checkAppreciation(req.user.userId, id);
  }
}
