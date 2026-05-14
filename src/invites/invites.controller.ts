// Invitation HTTP surface — MVP.
//
// Four routes:
//
//   POST  /invites            — auth required. Mint a new invite.
//   GET   /invites/me         — auth required. Sender's own invites.
//   POST  /invites/:id/revoke — auth required + ownership check.
//   GET   /invites/by-token/:token
//                             — PUBLIC. Returns the minimum payload
//                               the /i/<token> landing page needs.
//                               NEVER reveals sender / channel /
//                               platform / consumer.
//
// The public route is intentionally separate from the authed
// routes so the auth-guard placement is unambiguous: the by-token
// resolver bypasses JwtAuthGuard; everything else requires it.

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { InvitesService } from './invites.service';
import type { InviteChannel, InviteSocialPlatform } from './invite-provider';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

type CreateBody = {
  channel?: string;
  platform?: string | null;
};

// ── Authed routes ──────────────────────────────────────────────

@Controller('invites')
@UseGuards(JwtAuthGuard)
export class InvitesController {
  constructor(private invites: InvitesService) {}

  @Post()
  create(@Body() body: CreateBody, @Req() req: AuthedRequest) {
    return this.invites.create(req.user.userId, {
      channel: (body.channel ?? 'unknown') as InviteChannel,
      platform: (body.platform ?? null) as InviteSocialPlatform | null,
    });
  }

  @Get('me')
  listMine(@Req() req: AuthedRequest) {
    return this.invites.listMine(req.user.userId);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.invites.revoke(req.user.userId, id);
  }
}

// ── Public route ───────────────────────────────────────────────
//
// Lives on a separate controller so we can mount it WITHOUT
// JwtAuthGuard. Same /invites prefix but the by-token sub-path.
// The resolver returns isValid + expiresAt only — no PII, no
// channel hint, no platform.

@Controller('invites')
export class InvitesPublicController {
  constructor(private invites: InvitesService) {}

  @Get('by-token/:token')
  byToken(@Param('token') token: string) {
    return this.invites.resolvePublic(token);
  }
}
