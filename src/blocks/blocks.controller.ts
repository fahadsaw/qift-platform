import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BlocksService } from './blocks.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// All block routes are JWT-guarded — blocking is inherently a
// per-viewer concept, anonymous traffic has no use for any of these.
@Controller('blocks')
@UseGuards(JwtAuthGuard)
export class BlocksController {
  constructor(private service: BlocksService) {}

  // POST /blocks/:userId — block the target.
  // The blocker is always the JWT viewer; we never accept it from the
  // body to prevent a malicious client from blocking on someone else's
  // behalf.
  @Post(':userId')
  block(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.service.block(req.user.userId, userId);
  }

  // DELETE /blocks/:userId — unblock the target.
  @Delete(':userId')
  unblock(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.service.unblock(req.user.userId, userId);
  }

  // GET /blocks/me — return just the IDs I've blocked. Used by the
  // frontend search page to dim/hide already-blocked users client-side
  // (the backend already excludes them; this is for UX clarity).
  @Get('me')
  mine(@Req() req: AuthedRequest) {
    return this.service.listBlockedIds(req.user.userId);
  }
}
