// RosterService — CorporateContact import + lifecycle (Corporate
// Foundation PR 2; Corporate Core v2 §3).
//
// orgId always arrives from the OrgRoleGuard-attached context (the
// controller passes req.orgContext.orgId), so every query here is
// tenant-scoped by construction. Import is synchronous with hard
// caps (MAX_ROSTER_ROWS) — pilot scale; a job queue is a C2 concern
// outside the approved scope.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parseRoster, type SkippedRow } from './roster-csv';

const DAY_MS = 24 * 60 * 60 * 1000;

// How long an active roster row may live before the purge worker
// hard-deletes it. Companies re-import to refresh; stale rosters
// age out instead of accumulating (data minimization).
const DEFAULT_RETENTION_DAYS = 365;

// Grace window for archived rows — long enough to undo a fat-finger
// archive via re-import, short enough that removal means removal.
const DEFAULT_ARCHIVE_GRACE_DAYS = 30;

function envDays(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

const CONTACT_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  department: true,
  employeeRef: true,
  status: true,
  importBatchId: true,
  purgeAfter: true,
  createdAt: true,
} as const;

const LIST_PAGE_SIZE = 200;

@Injectable()
export class RosterService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // CSV import. Org must be APPROVED — unvetted orgs don't get to
  // park employee PII with us. File-level rejections (address
  // columns, unusable headers, caps) throw 400 with a stable code;
  // row-level problems skip the row and report it.
  async importRoster(actorUserId: string, orgId: string, csv: unknown) {
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw new BadRequestException('roster_csv_required');
    }
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, status: true },
    });
    if (!org) throw new NotFoundException('org_not_found');
    if (org.status !== 'approved') {
      throw new BadRequestException('org_not_approved');
    }

    const parsed = parseRoster(csv);
    if (!parsed.ok) {
      throw new BadRequestException({
        code: parsed.rejection.code,
        columns:
          'columns' in parsed.rejection ? (parsed.rejection.columns ?? []) : [],
        message:
          parsed.rejection.code === 'roster_address_columns_forbidden'
            ? 'Roster files must not contain address columns. Recipients confirm their own delivery address at claim time.'
            : 'Roster file could not be imported',
      });
    }

    // Dedup against the org's existing ACTIVE roster on either
    // channel. Bounded by MAX_ROSTER_ROWS-scale tables at pilot
    // size; revisit alongside any cap raise.
    const existing = await this.prisma.corporateContact.findMany({
      where: { orgId, status: 'active' },
      select: { email: true, phone: true },
    });
    const taken = new Set<string>();
    for (const c of existing) {
      if (c.email) taken.add(`e:${c.email}`);
      if (c.phone) taken.add(`p:${c.phone}`);
    }

    const skipped: SkippedRow[] = [...parsed.skipped];
    const toInsert = parsed.rows.filter((row) => {
      const keys = [
        row.email && `e:${row.email}`,
        row.phone && `p:${row.phone}`,
      ].filter(Boolean) as string[];
      if (keys.some((k) => taken.has(k))) {
        skipped.push({ line: row.line, reason: 'duplicate_existing' });
        return false;
      }
      return true;
    });

    const batchId = randomUUID();
    const purgeAfter = new Date(
      Date.now() +
        envDays('QIFT_ROSTER_RETENTION_DAYS', DEFAULT_RETENTION_DAYS) * DAY_MS,
    );
    if (toInsert.length > 0) {
      await this.prisma.corporateContact.createMany({
        data: toInsert.map((row) => ({
          orgId,
          fullName: row.fullName,
          email: row.email,
          phone: row.phone,
          department: row.department,
          employeeRef: row.employeeRef,
          importBatchId: batchId,
          purgeAfter,
        })),
      });
    }

    // Metadata stays at counts + column names — no contact PII in
    // the audit trail.
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.roster.import',
      targetType: 'organization',
      targetId: orgId,
      metadata: {
        batchId,
        imported: toInsert.length,
        skipped: skipped.length,
        ignoredColumns: parsed.ignoredColumns,
      },
    });

    skipped.sort((a, b) => a.line - b.line);
    return {
      batchId,
      imported: toInsert.length,
      skipped,
      ignoredColumns: parsed.ignoredColumns,
    };
  }

  // Paginated roster list, active by default. Roster PII is
  // admin/owner-surface only (enforced at the controller).
  async listContacts(
    orgId: string,
    opts: { status?: string; cursor?: string } = {},
  ) {
    const status = opts.status === 'archived' ? 'archived' : 'active';
    const items = await this.prisma.corporateContact.findMany({
      where: { orgId, status },
      select: CONTACT_SELECT,
      orderBy: { id: 'asc' },
      take: LIST_PAGE_SIZE + 1,
      ...(opts.cursor
        ? { cursor: { id: opts.cursor }, skip: 1 }
        : {}),
    });
    const hasMore = items.length > LIST_PAGE_SIZE;
    const page = hasMore ? items.slice(0, LIST_PAGE_SIZE) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  // Archive (soft-remove) one contact. Conditional updateMany keyed
  // on (id, orgId, active) — a contact in another org is
  // indistinguishable from a missing one. Archiving pulls the purge
  // deadline in to the grace window.
  async archiveContact(actorUserId: string, orgId: string, contactId: string) {
    const result = await this.prisma.corporateContact.updateMany({
      where: { id: contactId, orgId, status: 'active' },
      data: {
        status: 'archived',
        archivedAt: new Date(),
        purgeAfter: new Date(
          Date.now() +
            envDays('QIFT_ROSTER_ARCHIVE_GRACE_DAYS', DEFAULT_ARCHIVE_GRACE_DAYS) *
              DAY_MS,
        ),
      },
    });
    if (result.count === 0) {
      throw new NotFoundException('contact_not_found');
    }
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'org.roster.archive',
      targetType: 'organization',
      targetId: orgId,
      metadata: { contactId },
    });
    return { ok: true };
  }
}
