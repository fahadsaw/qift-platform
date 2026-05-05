import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FollowsService } from './follows.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Action endpoints (POST/DELETE) live at /follow/:userId — the route
// describes "follow this user" rather than the underlying join row.
// Listing endpoints live on UserFollowsController at /users/:userId/...
// to match REST sub-resource conventions and the frontend's call sites.
@Controller('follow')
@UseGuards(JwtAuthGuard)
export class FollowsController {
  constructor(private service: FollowsService) {}

  @Post(':userId')
  follow(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.service.follow(req.user.userId, userId);
  }

  @Delete(':userId')
  unfollow(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.service.unfollow(req.user.userId, userId);
  }
}

// Sibling controller for the listing endpoints. Sharing the FollowsService
// keeps the read/write surface unified without coupling UsersController
// to follow-graph concerns.
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserFollowsController {
  constructor(private service: FollowsService) {}

  @Get(':userId/followers')
  followers(@Param('userId') userId: string) {
    return this.service.listFollowers(userId);
  }

  @Get(':userId/following')
  following(@Param('userId') userId: string) {
    return this.service.listFollowing(userId);
  }
}
