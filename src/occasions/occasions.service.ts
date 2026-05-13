// OccasionsService — CRUD + privacy + recurrence for the Phase 6
// occasions infrastructure. The reminder FIRING job is gated to
// Phase 7; this service ONLY ships data-layer operations + the
// pure helpers from occasion-recurrence.ts / occasion-privacy.ts.
//
// Architecture: project_occasions_architecture.md in user memory.
// Single read-path enforcement: every endpoint that surfaces
// another user's occasion routes through `canSeeOccasion()`. There
// are NO bare `prisma.occasion.find*` queries outside this service.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from '../blocks/blocks.service';
import {
  defaultCadenceFor,
  isOccasionKind,
  type OccasionKind,
} from './occasion-kinds';
import {
  type OccasionVisibility,
  type ViewerContext,
} from './occasion-privacy';
import type { Calendar } from '../lib/hijri';
import {
  projectOwnOccasion,
  projectOccasionForViewer,
  sortUpcoming,
  type OccasionRow,
  type OwnerSummary,
  type PublicOccasion,
  type RelationshipOccasion,
} from './occasion-projection';

// Re-exported so controllers / sibling modules don't need to
// reach into the projection helper directly. The service is the
// stable seam.
export type {
  PublicOccasion,
  RelationshipOccasion,
} from './occasion-projection';

const LABEL_MAX = 80;
const VALID_CALENDARS: ReadonlyArray<Calendar> = ['gregorian', 'hijri'];
const VALID_RECURRENCES = ['once', 'yearly'] as const;
const VALID_VISIBILITIES: ReadonlyArray<OccasionVisibility> = [
  'private',
  'followers',
  'mutual',
  'public',
];
const VALID_CHANNELS = ['digest', 'real_time'] as const;

export type CreateOccasionInput = {
  kind?: string;
  label?: string | null;
  calendar?: string;
  year?: number | null;
  month?: number;
  day?: number;
  recurrence?: string;
  visibility?: string;
  regionCode?: string | null;
  relatedUserId?: string | null;
};

export type UpdateOccasionInput = Partial<CreateOccasionInput>;

export type CreateReminderInput = {
  daysBefore?: number;
  channel?: string;
  enabled?: boolean;
};

// Default window for the upcoming-for-followed feed. Wide enough
// to surface the next month of activity without flooding the UI;
// the caller can override via `windowDays` in the query string.
const DEFAULT_UPCOMING_WINDOW_DAYS = 30;
// Hard cap on the upcoming feed. Prevents accidental flooding when
// a user follows thousands of accounts; the UI is expected to
// paginate / lazy-load if a user genuinely needs more.
const UPCOMING_HARD_LIMIT = 100;

@Injectable()
export class OccasionsService {
  constructor(
    private prisma: PrismaService,
    private blocks: BlocksService,
  ) {}

  // ── CRUD: owner side ─────────────────────────────────────────

  // Create. Seeds the default reminder cadence for the kind so
  // Phase 7's firing job has a populated layer to switch on from
  // day one. The user can edit / disable per-row reminders after.
  async create(viewerId: string, body: CreateOccasionInput) {
    const data = this.validateCreateInput(body);

    // relatedUserId existence + non-self check. We don't validate
    // privacy against the related user — anyone can REMEMBER a
    // birthday for someone else; the related user only matters
    // for the reminder copy. They don't see this row by default.
    if (data.relatedUserId) {
      const related = await this.prisma.user.findUnique({
        where: { id: data.relatedUserId },
        select: { id: true, deletedAt: true },
      });
      if (!related || related.deletedAt) {
        throw new BadRequestException('relatedUserId not found');
      }
    }

    const occasion = await this.prisma.occasion.create({
      data: {
        userId: viewerId,
        kind: data.kind,
        label: data.label,
        calendar: data.calendar,
        year: data.year,
        month: data.month,
        day: data.day,
        recurrence: data.recurrence,
        visibility: data.visibility,
        regionCode: data.regionCode,
        relatedUserId: data.relatedUserId,
      },
    });

    // Seed default reminders. Best-effort: a duplicate (unique
    // constraint violation on re-create) is ignored. We don't
    // throw on seed failure — the occasion exists, the user can
    // add reminders manually if seeding misfires.
    const cadence = defaultCadenceFor(data.kind);
    for (const daysBefore of cadence) {
      try {
        await this.prisma.occasionReminder.create({
          data: {
            userId: viewerId,
            occasionId: occasion.id,
            daysBefore,
            channel: 'digest',
            enabled: true,
          },
        });
      } catch {
        /* idempotent seed; tolerate dup-key */
      }
    }

    return projectOwnOccasion(occasion, new Date());
  }

  // Owner's full list. Includes soft-deleted? No — the /occasions
  // page wants live rows only. Soft-deleted rows stay accessible
  // through historic Gift.occasionId joins.
  async listMine(viewerId: string): Promise<PublicOccasion[]> {
    const rows = await this.prisma.occasion.findMany({
      where: { userId: viewerId, deactivatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    return rows.map((r) => projectOwnOccasion(r, now));
  }

  // Single-occasion read by id. Auth-gated to the owner — public
  // viewing of a single occasion goes through `listForUser` (where
  // the viewer context drives the privacy filter).
  async findOneOwned(viewerId: string, id: string) {
    const row = await this.prisma.occasion.findFirst({
      where: { id, userId: viewerId, deactivatedAt: null },
    });
    if (!row) throw new NotFoundException('occasion_not_found');
    return projectOwnOccasion(row, new Date());
  }

  // Update. Partial PATCH; validates only the fields present.
  async update(viewerId: string, id: string, body: UpdateOccasionInput) {
    const existing = await this.prisma.occasion.findFirst({
      where: { id, userId: viewerId, deactivatedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('occasion_not_found');

    const patch = this.validatePartialInput(body);
    if (Object.keys(patch).length === 0) {
      return this.findOneOwned(viewerId, id);
    }
    const row = await this.prisma.occasion.update({
      where: { id },
      data: patch,
    });
    return projectOwnOccasion(row, new Date());
  }

  // Soft-delete. The architecture deliberately preserves the row
  // so Gift.occasionId tags keep resolving; the row just stops
  // appearing in the /occasions page + the public projection.
  async softDelete(viewerId: string, id: string): Promise<{ ok: true }> {
    const existing = await this.prisma.occasion.findFirst({
      where: { id, userId: viewerId, deactivatedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('occasion_not_found');
    await this.prisma.occasion.update({
      where: { id },
      data: { deactivatedAt: new Date() },
    });
    return { ok: true };
  }

  // ── Public read: another user's occasions ───────────────────

  // Return the OWNER's occasions that the VIEWER is allowed to
  // see, in the relationship-safe projection shape. The privacy
  // filter runs PER ROW — different rows on the same profile can
  // have different visibility tiers, and the result reflects
  // exactly what the viewer would see on the owner's profile.
  //
  // `owner` is omitted from each row's projection because the
  // route already identifies the owner (/users/:id/occasions).
  // The feed-style upcoming endpoint, in contrast, attaches it.
  async listForUser(
    viewerId: string,
    ownerId: string,
  ): Promise<RelationshipOccasion[]> {
    // Resolve the relationship context ONCE (block + follow
    // edges), then filter per row in memory — saves N+1 follow
    // queries when the owner has multiple occasions.
    const ctx = await this.buildViewerContext(viewerId, ownerId);
    const rows = await this.prisma.occasion.findMany({
      where: { userId: ownerId, deactivatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    const projected = rows
      .map((r) => projectOccasionForViewer(ctx, r as OccasionRow, now))
      .filter((p): p is RelationshipOccasion => p !== null);
    return projected;
  }

  // Upcoming-for-followed feed. Returns occasions belonging to
  // users the VIEWER currently follows (status='accepted'), within
  // the next `windowDays` days, ordered by soonest-first.
  //
  // Privacy: every row routes through projectOccasionForViewer,
  // which fails closed on any visibility tier the viewer doesn't
  // satisfy. Block-list is applied as a pre-filter so we never
  // even fetch the blocked accounts' rows.
  //
  // Scalability: the relationship context for each owner is built
  // in batch (one block lookup for the viewer + one follow query
  // for the reverse direction across all owners), giving O(1)
  // privacy filtering per row.
  //
  // Note: reminder FIRING (digest scheduling, push) is still
  // Phase 7. This endpoint just returns the data layer; the
  // frontend renders a calm calendar rail.
  async listUpcomingForFollowed(
    viewerId: string,
    opts: { windowDays?: number; limit?: number } = {},
  ): Promise<RelationshipOccasion[]> {
    const windowDays = Math.max(
      1,
      Math.min(opts.windowDays ?? DEFAULT_UPCOMING_WINDOW_DAYS, 365),
    );
    const limit = Math.max(1, Math.min(opts.limit ?? 50, UPCOMING_HARD_LIMIT));

    // Who does the viewer follow (accepted)? Excluded IDs are the
    // bidirectional block set — pre-filter at the SQL layer so
    // blocked owners' occasion rows never enter the in-memory
    // pipeline.
    const [follows, excludedIds] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerId: viewerId, status: 'accepted' },
        select: { followingId: true },
      }),
      this.blocks.listExcludedIds(viewerId),
    ]);
    const ownerIds = follows
      .map((f) => f.followingId)
      .filter((id) => !excludedIds.includes(id));
    if (ownerIds.length === 0) return [];

    // Fetch occasions for every followed owner. The (userId,
    // deactivatedAt) index handles the IN clause. We pull a
    // generous cap then trim post-projection, since some rows
    // will be filtered out by privacy or window.
    const FETCH_OVERFETCH = limit * 3;
    const rows = await this.prisma.occasion.findMany({
      where: { userId: { in: ownerIds }, deactivatedAt: null },
      orderBy: { createdAt: 'desc' },
      take: FETCH_OVERFETCH,
    });

    // Batch-resolve the reverse-follow edges (owner→viewer) so
    // the `mutual` tier check is one query for ALL owners
    // instead of one per owner. Same shape as listForUser but
    // batched across the followed set.
    const reverseFollows = await this.prisma.follow.findMany({
      where: {
        followerId: { in: ownerIds },
        followingId: viewerId,
        status: 'accepted',
      },
      select: { followerId: true },
    });
    const reverseSet = new Set(reverseFollows.map((r) => r.followerId));

    // Hydrate owner summaries in one User query.
    const users = await this.prisma.user.findMany({
      where: { id: { in: ownerIds }, deletedAt: null },
      select: {
        id: true,
        qiftUsername: true,
        fullName: true,
        avatarUrl: true,
      },
    });
    const ownerById = new Map<string, OwnerSummary>(
      users.map((u) => [u.id, u]),
    );

    const now = new Date();
    const windowEndMs = now.getTime() + windowDays * 24 * 60 * 60 * 1000;
    const projections = rows.map((r) => {
      const ctx: ViewerContext = {
        viewerId,
        // The fetch is already restricted to followed owners.
        viewerFollowsOwner: true,
        ownerFollowsViewer: reverseSet.has(r.userId!),
        // Block-list was pre-filtered. We pass false here, NOT
        // because we trust the pre-filter alone, but because the
        // pre-filter has already excluded the row entirely. If a
        // blocked row somehow reached this branch, the privacy
        // tier would still gate `private`-tier rows correctly.
        blocked: false,
      };
      return projectOccasionForViewer(
        ctx,
        r,
        now,
        ownerById.get(r.userId!) ?? null,
      );
    });

    return sortUpcoming(projections)
      .filter((p) => {
        if (!p.nextOccurrenceAt) return false;
        const ms = Date.parse(p.nextOccurrenceAt);
        return ms <= windowEndMs;
      })
      .slice(0, limit);
  }

  // ── Reminder CRUD ────────────────────────────────────────────

  async upsertReminder(
    viewerId: string,
    occasionId: string,
    body: CreateReminderInput,
  ) {
    // Ownership gate: the viewer must OWN the parent occasion to
    // attach a reminder to it. V1 doesn't support cross-user
    // reminders (a remembering user adding a reminder to someone
    // else's occasion); that's "+ Remember this birthday" in
    // Phase 6.4 and will create a NEW Occasion row, not a
    // foreign reminder.
    const occasion = await this.prisma.occasion.findFirst({
      where: { id: occasionId, userId: viewerId, deactivatedAt: null },
      select: { id: true },
    });
    if (!occasion) throw new NotFoundException('occasion_not_found');

    const days = body.daysBefore;
    if (
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      days < 0 ||
      days > 60
    ) {
      throw new BadRequestException('daysBefore must be an integer 0..60');
    }
    const channel = body.channel ?? 'digest';
    if (!(VALID_CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException('channel must be digest | real_time');
    }
    const enabled = body.enabled !== false;

    return this.prisma.occasionReminder.upsert({
      where: {
        userId_occasionId_daysBefore: {
          userId: viewerId,
          occasionId,
          daysBefore: days,
        },
      },
      create: {
        userId: viewerId,
        occasionId,
        daysBefore: days,
        channel,
        enabled,
      },
      update: { channel, enabled },
    });
  }

  async deleteReminder(
    viewerId: string,
    occasionId: string,
    reminderId: string,
  ): Promise<{ ok: true }> {
    const reminder = await this.prisma.occasionReminder.findFirst({
      where: { id: reminderId, userId: viewerId, occasionId },
      select: { id: true },
    });
    if (!reminder) throw new NotFoundException('reminder_not_found');
    await this.prisma.occasionReminder.delete({ where: { id: reminderId } });
    return { ok: true };
  }

  async listRemindersForOccasion(viewerId: string, occasionId: string) {
    // Ownership gate.
    const occasion = await this.prisma.occasion.findFirst({
      where: { id: occasionId, userId: viewerId, deactivatedAt: null },
      select: { id: true },
    });
    if (!occasion) throw new NotFoundException('occasion_not_found');
    return this.prisma.occasionReminder.findMany({
      where: { userId: viewerId, occasionId },
      orderBy: { daysBefore: 'desc' },
    });
  }

  // ── Helpers ──────────────────────────────────────────────────

  // Build the per-(viewer, owner) relationship context used by
  // canSeeOccasion. Block detection delegates to BlocksService so
  // the bidirectional-block logic stays centralized (every read
  // path in the codebase uses the same definition of "blocked").
  // The result is reused across every occasion row in a list
  // query so the privacy filter is O(1) per row instead of O(N).
  private async buildViewerContext(
    viewerId: string,
    ownerId: string,
  ): Promise<ViewerContext> {
    if (viewerId === ownerId) {
      return {
        viewerId,
        viewerFollowsOwner: false,
        ownerFollowsViewer: false,
        blocked: false,
      };
    }
    const [excludedIds, viewerFollows, ownerFollows] = await Promise.all([
      this.blocks.listExcludedIds(viewerId),
      this.prisma.follow.findFirst({
        where: {
          followerId: viewerId,
          followingId: ownerId,
          status: 'accepted',
        },
        select: { followerId: true },
      }),
      this.prisma.follow.findFirst({
        where: {
          followerId: ownerId,
          followingId: viewerId,
          status: 'accepted',
        },
        select: { followerId: true },
      }),
    ]);
    return {
      viewerId,
      viewerFollowsOwner: !!viewerFollows,
      ownerFollowsViewer: !!ownerFollows,
      blocked: excludedIds.includes(ownerId),
    };
  }

  // ── Validation ──────────────────────────────────────────────

  private validateCreateInput(body: CreateOccasionInput): {
    kind: OccasionKind;
    label: string | null;
    calendar: Calendar;
    year: number | null;
    month: number;
    day: number;
    recurrence: 'once' | 'yearly';
    visibility: OccasionVisibility;
    regionCode: string | null;
    relatedUserId: string | null;
  } {
    const kind = body.kind;
    if (!kind || !isOccasionKind(kind)) {
      throw new BadRequestException(
        'kind is required and must be allow-listed',
      );
    }
    const calendar = body.calendar;
    if (
      !calendar ||
      !(VALID_CALENDARS as readonly string[]).includes(calendar)
    ) {
      throw new BadRequestException('calendar must be gregorian | hijri');
    }
    const recurrence = body.recurrence;
    if (
      !recurrence ||
      !(VALID_RECURRENCES as readonly string[]).includes(recurrence)
    ) {
      throw new BadRequestException('recurrence must be once | yearly');
    }
    if (
      typeof body.month !== 'number' ||
      body.month < 1 ||
      body.month > 12 ||
      !Number.isInteger(body.month)
    ) {
      throw new BadRequestException('month must be 1..12');
    }
    if (
      typeof body.day !== 'number' ||
      body.day < 1 ||
      body.day > 31 ||
      !Number.isInteger(body.day)
    ) {
      throw new BadRequestException('day must be 1..31');
    }
    // 'once' MUST have a year; 'yearly' may omit it.
    let year: number | null;
    if (recurrence === 'once') {
      if (
        typeof body.year !== 'number' ||
        body.year < 1900 ||
        body.year > 3000 ||
        !Number.isInteger(body.year)
      ) {
        throw new BadRequestException('once recurrence requires a year');
      }
      year = body.year;
    } else {
      year =
        typeof body.year === 'number' &&
        body.year >= 1900 &&
        body.year <= 3000 &&
        Number.isInteger(body.year)
          ? body.year
          : null;
    }
    const visibilityRaw = body.visibility ?? 'private';
    if (!(VALID_VISIBILITIES as readonly string[]).includes(visibilityRaw)) {
      throw new BadRequestException(
        'visibility must be private | followers | mutual | public',
      );
    }
    const label =
      typeof body.label === 'string'
        ? body.label.trim().slice(0, LABEL_MAX) || null
        : null;
    const regionCode =
      typeof body.regionCode === 'string'
        ? body.regionCode.trim().toUpperCase().slice(0, 16) || null
        : null;
    const relatedUserId =
      typeof body.relatedUserId === 'string' && body.relatedUserId.length > 0
        ? body.relatedUserId
        : null;
    return {
      kind: kind,
      label,
      calendar: calendar as Calendar,
      year,
      month: body.month,
      day: body.day,
      recurrence: recurrence as 'once' | 'yearly',
      visibility: visibilityRaw as OccasionVisibility,
      regionCode,
      relatedUserId,
    };
  }

  // Validate a partial PATCH. Returns ONLY the keys present in
  // the body, with the same type / range checks. Used by update().
  private validatePartialInput(
    body: UpdateOccasionInput,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (body.kind !== undefined) {
      if (!isOccasionKind(body.kind)) {
        throw new BadRequestException('kind must be allow-listed');
      }
      out.kind = body.kind;
    }
    if (body.label !== undefined) {
      out.label =
        typeof body.label === 'string'
          ? body.label.trim().slice(0, LABEL_MAX) || null
          : null;
    }
    if (body.calendar !== undefined) {
      if (!(VALID_CALENDARS as readonly string[]).includes(body.calendar)) {
        throw new BadRequestException('calendar must be gregorian | hijri');
      }
      out.calendar = body.calendar;
    }
    if (body.year !== undefined) {
      if (body.year === null) {
        out.year = null;
      } else if (
        typeof body.year !== 'number' ||
        body.year < 1900 ||
        body.year > 3000 ||
        !Number.isInteger(body.year)
      ) {
        throw new BadRequestException('year must be an integer 1900..3000');
      } else {
        out.year = body.year;
      }
    }
    if (body.month !== undefined) {
      if (
        typeof body.month !== 'number' ||
        body.month < 1 ||
        body.month > 12 ||
        !Number.isInteger(body.month)
      ) {
        throw new BadRequestException('month must be 1..12');
      }
      out.month = body.month;
    }
    if (body.day !== undefined) {
      if (
        typeof body.day !== 'number' ||
        body.day < 1 ||
        body.day > 31 ||
        !Number.isInteger(body.day)
      ) {
        throw new BadRequestException('day must be 1..31');
      }
      out.day = body.day;
    }
    if (body.recurrence !== undefined) {
      if (!(VALID_RECURRENCES as readonly string[]).includes(body.recurrence)) {
        throw new BadRequestException('recurrence must be once | yearly');
      }
      out.recurrence = body.recurrence;
    }
    if (body.visibility !== undefined) {
      if (
        !(VALID_VISIBILITIES as readonly string[]).includes(body.visibility)
      ) {
        throw new BadRequestException(
          'visibility must be private | followers | mutual | public',
        );
      }
      out.visibility = body.visibility;
    }
    if (body.regionCode !== undefined) {
      out.regionCode =
        typeof body.regionCode === 'string'
          ? body.regionCode.trim().toUpperCase().slice(0, 16) || null
          : null;
    }
    if (body.relatedUserId !== undefined) {
      out.relatedUserId =
        typeof body.relatedUserId === 'string' && body.relatedUserId.length > 0
          ? body.relatedUserId
          : null;
    }
    return out;
  }
}
