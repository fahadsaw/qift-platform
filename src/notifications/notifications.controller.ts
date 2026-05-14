import { Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { NotificationsService } from './notifications.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// All notification routes require a valid JWT. Ownership is enforced in
// the service: the viewer's id is the only userId that can ever appear in
// a query — a client can't see or mutate someone else's notifications.
//
// PRODUCTION POSTURE: there is NO public POST endpoint here. All
// notifications are produced server-side by domain services
// (GiftsService, StoreService, AddressesService, GiftPostsService,
// OccasionReminderWorker, DigestWorker, etc.) routed through
// NotificationsService.trigger → NotificationOrchestrator. The
// orchestrator is the single audit/routing/budget/quiet-hours seam.
// Producer-side privacy (surprise mask, categorisation, deep-link
// safety) all converge there.
//
// A previous draft exposed `POST /notifications` that wrote arbitrary
// {type, title, body, link} rows directly to the viewer's own inbox,
// bypassing the orchestrator entirely. It had no frontend callers and
// no architectural justification — it was scaffold-era debugging
// code. Removed before Phase 7 broader rollout. If a future need
// arises (admin nudges, system messages from /admin), build a
// dedicated admin-only producer that ALSO routes through the
// orchestrator — never a public catch-all create endpoint.
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
