import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { NotificationsService } from './notifications.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

type CreateBody = {
  type?: string;
  title?: string;
  body?: string | null;
  link?: string | null;
};

// All notification routes require a valid JWT. Ownership is enforced in
// the service: the viewer's id is the only userId that can ever appear in
// a query — a client can't see or mutate someone else's notifications.
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private service: NotificationsService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.service.list(req.user.userId);
  }

  // Lightweight badge endpoint so the bell doesn't have to fetch the full
  // list to render its number. Returns `{ unread: number }`.
  @Get('unread-count')
  async unreadCount(@Req() req: AuthedRequest) {
    const unread = await this.service.unreadCount(req.user.userId);
    return { unread };
  }

  @Post()
  create(@Body() body: CreateBody, @Req() req: AuthedRequest) {
    return this.service.create(req.user.userId, {
      type: body.type ?? 'generic',
      title: body.title ?? '',
      body: body.body ?? null,
      link: body.link ?? null,
    });
  }

  // PATCH /notifications/read-all comes BEFORE the :id route so Nest
  // doesn't try to bind "read-all" as the id param.
  @Patch('read-all')
  markAllRead(@Req() req: AuthedRequest) {
    return this.service.markAllRead(req.user.userId);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.markRead(req.user.userId, id);
  }
}
