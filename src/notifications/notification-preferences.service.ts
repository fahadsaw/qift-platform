// Phase 7.1 — NotificationPreferences read/write service.
//
// Owns the lifecycle of the per-user NotificationPreferences row.
// Reads are lazy (missing row = "all defaults"); writes upsert.
// The orchestrator depends ONLY on the read path; the controller
// drives writes.
//
// Validation rules enforced here:
//   - Quiet-hours pair must be BOTH set or BOTH null. Half-
//     configured states are rejected (the helper would otherwise
//     short-circuit to "no quiet hours", which is the safe but
//     surprising behaviour).
//   - HH:MM strings must match /^\d{1,2}:\d{1,2}$/ with H in 0..23
//     and M in 0..59.
//   - Timezone must be a known IANA identifier (probed via Intl).
//   - Mandatory categories CANNOT be opted out — those entries
//     are silently dropped from the dict before write.
//   - digestFrequency must be 'daily' or 'weekly'.
//
// Privacy: the response shape includes ONLY the preferences
// columns. We never inline join other user data (the preferences
// surface lives on /users/me/notification-preferences and is
// scoped to the viewer's own row).

import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type NotificationCategory,
  isMandatory,
  listCategories,
} from './notification-categories';

// ── Public shape (wire format) ──────────────────────────────────

export type NotificationPreferencesView = {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string;
  // Echoed as a flat dict on the wire so the frontend can render
  // the per-category toggle list without parsing JSON itself.
  categoryOptOuts: Record<string, boolean>;
  digestEnabled: boolean;
  digestFrequency: 'daily' | 'weekly';
};

export type UpdateNotificationPreferencesInput = {
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  quietHoursTimezone?: string;
  categoryOptOuts?: Record<string, boolean>;
  digestEnabled?: boolean;
  digestFrequency?: string;
};

// ── Defaults (used for missing rows) ────────────────────────────

const DEFAULT_VIEW: NotificationPreferencesView = {
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: 'Asia/Riyadh',
  categoryOptOuts: {},
  digestEnabled: true,
  digestFrequency: 'daily',
};

@Injectable()
export class NotificationPreferencesService {
  constructor(private prisma: PrismaService) {}

  async getForViewer(userId: string): Promise<NotificationPreferencesView> {
    const row = await this.prisma.notificationPreferences.findUnique({
      where: { userId },
    });
    if (!row) return { ...DEFAULT_VIEW };
    return {
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
      quietHoursTimezone: row.quietHoursTimezone,
      categoryOptOuts: coerceOptOuts(row.categoryOptOuts),
      digestEnabled: row.digestEnabled,
      digestFrequency: row.digestFrequency === 'weekly' ? 'weekly' : 'daily',
    };
  }

  async updateForViewer(
    userId: string,
    patch: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferencesView> {
    // Validate every field that's present. Missing fields are
    // left untouched (PATCH semantics).
    const data: {
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
      quietHoursTimezone?: string;
      categoryOptOuts?: Record<string, boolean>;
      digestEnabled?: boolean;
      digestFrequency?: string;
    } = {};

    // Quiet hours — validate as a pair.
    const startTouched = patch.quietHoursStart !== undefined;
    const endTouched = patch.quietHoursEnd !== undefined;
    if (startTouched || endTouched) {
      // Caller can clear BOTH by passing null. Half-clear is an
      // error (the helper would short-circuit to "no quiet hours"
      // which is surprising).
      const start = startTouched ? patch.quietHoursStart : undefined;
      const end = endTouched ? patch.quietHoursEnd : undefined;
      if (start === null && end === null) {
        data.quietHoursStart = null;
        data.quietHoursEnd = null;
      } else if (start === null || end === null) {
        throw new BadRequestException(
          'quietHoursStart and quietHoursEnd must both be set or both null',
        );
      } else if (start !== undefined || end !== undefined) {
        // At this point both are strings (or one was untouched).
        // For an untouched side, we must reject the partial write
        // — quiet hours are validated as a paired contract.
        if (start === undefined || end === undefined) {
          throw new BadRequestException(
            'quietHoursStart and quietHoursEnd must be patched together',
          );
        }
        validateHhmm(start, 'quietHoursStart');
        validateHhmm(end, 'quietHoursEnd');
        data.quietHoursStart = start;
        data.quietHoursEnd = end;
      }
    }

    if (patch.quietHoursTimezone !== undefined) {
      validateTimezone(patch.quietHoursTimezone);
      data.quietHoursTimezone = patch.quietHoursTimezone;
    }

    if (patch.categoryOptOuts !== undefined) {
      data.categoryOptOuts = sanitiseOptOuts(patch.categoryOptOuts);
    }

    if (patch.digestEnabled !== undefined) {
      data.digestEnabled = patch.digestEnabled === true;
    }

    if (patch.digestFrequency !== undefined) {
      if (
        patch.digestFrequency !== 'daily' &&
        patch.digestFrequency !== 'weekly'
      ) {
        throw new BadRequestException(
          'digestFrequency must be "daily" or "weekly"',
        );
      }
      data.digestFrequency = patch.digestFrequency;
    }

    if (Object.keys(data).length === 0) {
      // No-op patch — return the current state without writing.
      return this.getForViewer(userId);
    }

    await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.getForViewer(userId);
  }

  // Static category catalogue exposed to the frontend so the
  // preferences UI can render the per-category toggle list with
  // mandatory rows correctly disabled.
  listCategoriesView() {
    return listCategories().map(({ id, descriptor }) => ({
      id,
      priority: descriptor.priority,
      mandatory: descriptor.mandatory,
      dailyCap: descriptor.dailyCap,
      weeklyCap: descriptor.weeklyCap,
    }));
  }
}

// ── Validators ──────────────────────────────────────────────────

function validateHhmm(value: string, fieldName: string): void {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(value);
  if (!m) {
    throw new BadRequestException(`${fieldName} must be in HH:MM format`);
  }
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new BadRequestException(
      `${fieldName} hours must be 0..23 and minutes 0..59`,
    );
  }
}

function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  } catch {
    throw new BadRequestException(
      'quietHoursTimezone is not a recognised IANA timezone',
    );
  }
}

// Drop unrecognised keys + mandatory categories from the dict.
// Mandatory categories CANNOT be opted out architecturally; we
// silently strip them at the write boundary instead of throwing
// (a stale frontend with cached state might post them).
function sanitiseOptOuts(
  dict: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'boolean') continue;
    // Validate the key is a known category.
    const knownIds = listCategories().map((c) => c.id) as string[];
    if (!knownIds.includes(k)) continue;
    // Mandatory categories silently dropped.
    if (isMandatory(k as NotificationCategory)) continue;
    out[k] = v;
  }
  return out;
}

// JSON column → typed dict (defensive: corrupted data → {}).
function coerceOptOuts(raw: unknown): Record<string, boolean> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
