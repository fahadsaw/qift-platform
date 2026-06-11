// RosterService unit tests — Corporate Foundation PR 2.
//
// Hand-rolled Prisma mock, direct construction (house pattern).
// Covered: the approved-org gate, file-level rejection passthrough
// (address columns), DB-level dedup, persisted-row shape (orgId from
// the caller = guard context, purgeAfter always set), audit hygiene
// (counts only — no contact PII), pagination, and the
// tenant-scoped conditional archive.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RosterService } from './roster.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type PrismaMock = {
  organization: { findUnique: jest.Mock };
  corporateContact: {
    findMany: jest.Mock;
    createMany: jest.Mock;
    updateMany: jest.Mock;
  };
};

const CSV =
  'name,email,phone\n' +
  'Sara Ali,sara@corp.sa,0501234567\n' +
  'Omar Said,omar@corp.sa,0509999999\n';

describe('RosterService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let service: RosterService;

  beforeEach(() => {
    prisma = {
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'org-1', status: 'approved' }),
      },
      corporateContact: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new RosterService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────
  describe('importRoster — gates', () => {
    it('requires a non-empty csv string', async () => {
      await expect(service.importRoster('u1', 'org-1', undefined)).rejects.toThrow(
        'roster_csv_required',
      );
      await expect(service.importRoster('u1', 'org-1', '  ')).rejects.toThrow(
        'roster_csv_required',
      );
    });

    it('404s when the org row is missing', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);
      await expect(service.importRoster('u1', 'org-x', CSV)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each(['draft', 'submitted', 'rejected', 'changes_requested', 'suspended'])(
      'refuses roster PII for a %s (non-approved) org',
      async (status) => {
        prisma.organization.findUnique.mockResolvedValue({
          id: 'org-1',
          status,
        });
        await expect(service.importRoster('u1', 'org-1', CSV)).rejects.toThrow(
          'org_not_approved',
        );
        expect(prisma.corporateContact.createMany).not.toHaveBeenCalled();
      },
    );

    it('rejects address columns with the stable code AND the offending names', async () => {
      const csv = 'name,phone,home address\nSara,0501234567,Riyadh\n';
      try {
        await service.importRoster('u1', 'org-1', csv);
        throw new Error('expected importRoster to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const body = (e as BadRequestException).getResponse() as {
          code: string;
          columns: string[];
        };
        expect(body.code).toBe('roster_address_columns_forbidden');
        expect(body.columns).toEqual(['home address']);
      }
      expect(prisma.corporateContact.createMany).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('importRoster — persistence', () => {
    it('inserts rows scoped to the caller orgId with purgeAfter set', async () => {
      const result = await service.importRoster('u1', 'org-1', CSV);
      expect(result.imported).toBe(2);
      expect(result.skipped).toEqual([]);
      const { data } = prisma.corporateContact.createMany.mock.calls[0][0];
      expect(data).toHaveLength(2);
      for (const row of data) {
        expect(row.orgId).toBe('org-1');
        expect(row.purgeAfter).toBeInstanceOf(Date);
        expect(row.purgeAfter.getTime()).toBeGreaterThan(Date.now());
        expect(row.importBatchId).toBe(result.batchId);
      }
      expect(data[0]).toMatchObject({
        fullName: 'Sara Ali',
        email: 'sara@corp.sa',
        phone: '+966501234567',
      });
    });

    it('dedups against the org’s existing ACTIVE roster on either channel', async () => {
      prisma.corporateContact.findMany.mockResolvedValue([
        { email: 'sara@corp.sa', phone: null },
        { email: null, phone: '+966509999999' },
      ]);
      const result = await service.importRoster('u1', 'org-1', CSV);
      expect(result.imported).toBe(0);
      expect(result.skipped).toEqual([
        { line: 2, reason: 'duplicate_existing' },
        { line: 3, reason: 'duplicate_existing' },
      ]);
      // The dedup read is tenant-scoped and active-only.
      expect(prisma.corporateContact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: 'org-1', status: 'active' },
        }),
      );
      expect(prisma.corporateContact.createMany).not.toHaveBeenCalled();
    });

    it('audits counts + batch id — never contact names/channels', async () => {
      await service.importRoster('u1', 'org-1', CSV);
      const call = audit.record.mock.calls[0][0];
      expect(call).toMatchObject({
        actorUserId: 'u1',
        actorType: 'user',
        action: 'org.roster.import',
        targetType: 'organization',
        targetId: 'org-1',
      });
      const meta = JSON.stringify(call.metadata);
      expect(call.metadata.imported).toBe(2);
      expect(meta).not.toContain('Sara');
      expect(meta).not.toContain('corp.sa');
      expect(meta).not.toContain('+966');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('listContacts', () => {
    it('lists active contacts for the org with a page cap', async () => {
      prisma.corporateContact.findMany.mockResolvedValue([]);
      await service.listContacts('org-1');
      expect(prisma.corporateContact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: 'org-1', status: 'active' },
          take: 201,
        }),
      );
    });

    it('unknown status values collapse to active (no filter injection)', async () => {
      await service.listContacts('org-1', { status: 'deleted OR 1=1' });
      expect(prisma.corporateContact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: 'org-1', status: 'active' },
        }),
      );
    });

    it('returns nextCursor when a full page comes back', async () => {
      const rows = Array.from({ length: 201 }, (_, i) => ({
        id: `c-${String(i).padStart(3, '0')}`,
      }));
      prisma.corporateContact.findMany.mockResolvedValue(rows);
      const res = await service.listContacts('org-1');
      expect(res.items).toHaveLength(200);
      expect(res.nextCursor).toBe('c-199');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('archiveContact', () => {
    it('archives via a conditional update keyed on (id, orgId, active)', async () => {
      await service.archiveContact('u1', 'org-1', 'c-1');
      expect(prisma.corporateContact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c-1', orgId: 'org-1', status: 'active' },
          data: expect.objectContaining({
            status: 'archived',
            archivedAt: expect.any(Date),
            purgeAfter: expect.any(Date),
          }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'org.roster.archive' }),
      );
    });

    it('TENANT ISOLATION: a contact in another org reads as not-found', async () => {
      prisma.corporateContact.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.archiveContact('u1', 'org-1', 'contact-of-org-2'),
      ).rejects.toThrow('contact_not_found');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('archiving pulls purgeAfter IN (grace window, not full retention)', async () => {
      await service.archiveContact('u1', 'org-1', 'c-1');
      const { data } = prisma.corporateContact.updateMany.mock.calls[0][0];
      const days = (data.purgeAfter.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(25);
      expect(days).toBeLessThan(35); // default 30d grace
    });
  });
});
