import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  SocialAccountsService,
  type LinkInput,
  type UpdateInput,
} from './social-accounts.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// All write routes are JWT-guarded so a row can only be created /
// edited / deleted by its owner.
//
// `findByUser` (the public-profile read path) is JWT-guarded too —
// matches the rest of /users/* — so anonymous traffic can't enumerate
// social handles for username scraping. The handles themselves are
// public-by-intent on a user's profile, but requiring auth for the
// listing keeps the surface symmetric with /users/@/:username.
//
// Note: the previous controller exposed an unauthenticated POST that
// accepted `body: any` and a `findAll()` route returning EVERY social
// account in the DB. Both removed.
@Controller('social-accounts')
@UseGuards(JwtAuthGuard)
export class SocialAccountsController {
  constructor(private service: SocialAccountsService) {}

  // POST /social-accounts — manual link. Body: { platform, handle }.
  // userId is taken from the JWT — never trust client input.
  @Post()
  link(@Body() body: LinkInput, @Req() req: AuthedRequest) {
    return this.service.link(req.user.userId, body);
  }

  // GET /social-accounts/me — viewer's own list (manage screen).
  @Get('me')
  mine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user.userId);
  }

  // PATCH /social-accounts/:id — update handle of an owned row.
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.updateHandle(req.user.userId, id, body);
  }

  // DELETE /social-accounts/:id — unlink an owned row.
  @Delete(':id')
  unlink(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.unlink(req.user.userId, id);
  }

  // GET /social-accounts/:userId — public-ish projection of another
  // user's accounts. Used by /u/[username]. Same projection as
  // listMine; both are fine to serialise because handles are
  // public-by-intent.
  @Get(':userId')
  findByUser(@Param('userId') userId: string) {
    return this.service.findByUser(userId);
  }
}
