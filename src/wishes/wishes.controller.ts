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
  WishesService,
  type CreateWishInput,
  type UpdateWishInput,
} from './wishes.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Routes:
//   POST   /wishes       — create a wish owned by the JWT subject.
//   GET    /wishes/me    — list the JWT subject's wishes (public + private).
//   PATCH  /wishes/:id   — update one of the JWT subject's wishes.
//   DELETE /wishes/:id   — delete one of the JWT subject's wishes.
//
// Public-profile reads still live on UsersController as
// `GET /users/:userId/wishes` (privacy-gated, public-only).
//
// `:id` route order: `me` declared before `:id` so the literal segment
// wins the match.
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

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateWishInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.update(req.user.userId, id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.remove(req.user.userId, id);
  }
}
