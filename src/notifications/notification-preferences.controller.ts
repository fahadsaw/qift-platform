// Phase 7.1 — REST surface for per-user notification preferences.
//
// Routes:
//   GET    /users/me/notification-preferences
//   PATCH  /users/me/notification-preferences
//   GET    /notifications/categories
//
// Why `/users/me/...` for the preferences pair: matches the
// existing /users/me/privacy convention (`UsersController`
// already owns `me/privacy`, `me/profile`, `me/email`,
// `me/preferences` for wishlist preferences). Notification
// preferences belong on the same /users/me/* shelf — the user's
// own settings hub.
//
// Why a separate /notifications/categories endpoint: the
// frontend renders the per-category opt-out list; it needs the
// CATALOGUE (which categories exist + which are mandatory) to
// build the UI. Decoupling the catalogue from the user's row
// avoids tying the UI render to the lazy-row's existence.
//
// All routes are JWT-protected. Ownership: the userId is ALWAYS
// `req.user.userId` (the JWT subject) — a client cannot read or
// write someone else's preferences.

import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  NotificationPreferencesService,
  type UpdateNotificationPreferencesInput,
} from './notification-preferences.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

@Controller('users')
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(private prefs: NotificationPreferencesService) {}

  // Lazy-read. Missing row → all-defaults view; the row is only
  // created when the user PATCHes something.
  @Get('me/notification-preferences')
  getMine(@Req() req: AuthedRequest) {
    return this.prefs.getForViewer(req.user.userId);
  }

  // PATCH semantics: every field is optional. Missing fields are
  // unchanged. Validation throws BadRequestException for malformed
  // HH:MM, unrecognised timezone, etc.
  @Patch('me/notification-preferences')
  patchMine(
    @Body() body: UpdateNotificationPreferencesInput,
    @Req() req: AuthedRequest,
  ) {
    return this.prefs.updateForViewer(req.user.userId, body);
  }
}

// Sibling controller — exposes the static category catalogue.
// JWT-protected so we don't leak the platform's internal
// category names + caps to anonymous traffic (low-stakes leak,
// but consistent with the rest of /notifications/* requiring auth).
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationCategoriesController {
  constructor(private prefs: NotificationPreferencesService) {}

  @Get('categories')
  listCategories() {
    return this.prefs.listCategoriesView();
  }
}
