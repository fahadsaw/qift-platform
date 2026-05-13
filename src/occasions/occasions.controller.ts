// REST surface for the Phase 6 occasions infrastructure.
//
// All routes are JWT-protected. The service layer enforces
// ownership for the owner-side routes and privacy for the
// public-side route.

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
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  OccasionsService,
  type CreateOccasionInput,
  type CreateReminderInput,
  type UpdateOccasionInput,
} from './occasions.service';

type AuthedRequest = { user?: { userId: string; qiftUsername: string } };

@Controller('occasions')
@UseGuards(JwtAuthGuard)
export class OccasionsController {
  constructor(private service: OccasionsService) {}

  // Owner's full list.
  @Get('me')
  listMine(@Req() req: AuthedRequest) {
    return this.service.listMine(req.user!.userId);
  }

  // Single owned occasion (for the edit modal hydrate).
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.findOneOwned(req.user!.userId, id);
  }

  @Post()
  create(@Body() body: CreateOccasionInput, @Req() req: AuthedRequest) {
    return this.service.create(req.user!.userId, body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateOccasionInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.update(req.user!.userId, id, body);
  }

  @Delete(':id')
  softDelete(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.softDelete(req.user!.userId, id);
  }

  // Reminder CRUD. Upsert-by-(userId, occasionId, daysBefore) so
  // the frontend can call POST repeatedly without first checking
  // whether a row exists.
  @Get(':id/reminders')
  listReminders(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.listRemindersForOccasion(req.user!.userId, id);
  }

  @Post(':id/reminders')
  upsertReminder(
    @Param('id') id: string,
    @Body() body: CreateReminderInput,
    @Req() req: AuthedRequest,
  ) {
    return this.service.upsertReminder(req.user!.userId, id, body);
  }

  @Delete(':id/reminders/:reminderId')
  deleteReminder(
    @Param('id') id: string,
    @Param('reminderId') reminderId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.service.deleteReminder(req.user!.userId, id, reminderId);
  }
}

// Public-profile route for "occasions on someone else's profile".
// Lives on the /users/:userId/occasions path (matching the rest
// of the user-side public reads — wishes, gifts/received,
// gifts/sent). The service layer applies the per-row visibility
// filter using the viewer's follow / block context.
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserOccasionsController {
  constructor(private service: OccasionsService) {}

  @Get(':userId/occasions')
  listForUser(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.service.listForUser(req.user!.userId, userId);
  }
}
