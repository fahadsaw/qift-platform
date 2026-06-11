// OrgService unit tests — Corporate Foundation PR 1 (org spine).
//
// Pure unit tests: the service is constructed directly with a
// hand-rolled PrismaService mock (no Nest DI, no DB) and an audit
// stub, same pattern as beta-access.service.spec.ts. Covered:
//
//   1. createOrg — validation, draft+owner-seat transaction, audit.
//   2. myOrgs    — active-seat scoping (revokedAt: null).
//   3. submitOrg — submittable-state matrix + CR requirement.
//   4. reviewOrg — approve/reject/request_changes semantics,
//      reason requirement, submitted-only conflict, audit metadata.
//   5. Projection hygiene — org-plane reads never select reviewer
//      identity (reviewedBy stays ops-only).

import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { OrgService } from './org.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

type PrismaMock = {
  organization: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
  orgUser: {
    create: jest.Mock;
    findMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

const orgRow = (over: Record<string, unknown> = {}) => ({
  id: 'org-1',
  legalName: 'Acme Trading Co LLC',
  displayName: 'Acme',
  displayNameAr: null,
  crNumber: '1010101010',
  vatNumber: null,
  billingEmail: null,
  billingAddress: null,
  status: 'draft',
  rejectionReason: null,
  submittedAt: null,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  ...over,
});

describe('OrgService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let service: OrgService;

  beforeEach(() => {
    prisma = {
      organization: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve(orgRow({ ...data })),
        ),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve(orgRow({ ...data })),
        ),
      },
      orgUser: {
        create: jest.fn().mockResolvedValue({ id: 'seat-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // The service's createOrg transaction only needs the same two
      // delegates — hand the full mock through as `tx`.
      $transaction: jest.fn().mockImplementation((fn) => fn(prisma)),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new OrgService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────
  describe('createOrg', () => {
    it('rejects a missing or too-short legalName', async () => {
      await expect(service.createOrg('u1', {})).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.createOrg('u1', { legalName: 'ab', displayName: 'Acme' }),
      ).rejects.toThrow('org_legal_name_required');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a missing displayName', async () => {
      await expect(
        service.createOrg('u1', { legalName: 'Acme Trading Co' }),
      ).rejects.toThrow('org_display_name_required');
    });

    it('creates the draft org AND the owner seat in one transaction', async () => {
      await service.createOrg('u1', {
        legalName: '  Acme Trading Co LLC  ',
        displayName: 'Acme',
        billingEmail: 'Billing@Acme.SA',
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.organization.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            legalName: 'Acme Trading Co LLC', // trimmed
            displayName: 'Acme',
            billingEmail: 'billing@acme.sa', // lowercased
            createdBy: 'u1',
          }),
        }),
      );
      expect(prisma.orgUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orgId: 'org-1',
            userId: 'u1',
            role: 'owner',
            acceptedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('records org.create in the audit log with actorType user', async () => {
      await service.createOrg('u1', {
        legalName: 'Acme Trading Co LLC',
        displayName: 'Acme',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'u1',
          actorType: 'user',
          action: 'org.create',
          targetType: 'organization',
          targetId: 'org-1',
        }),
      );
    });

    it('does NOT default status — the schema default (draft) owns it', async () => {
      await service.createOrg('u1', {
        legalName: 'Acme Trading Co LLC',
        displayName: 'Acme',
      });
      const data = prisma.organization.create.mock.calls[0][0].data;
      expect(data.status).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('myOrgs', () => {
    it('scopes to the caller’s ACTIVE seats only (revokedAt null)', async () => {
      prisma.orgUser.findMany.mockResolvedValue([
        { role: 'owner', org: orgRow() },
      ]);
      const result = await service.myOrgs('u1');
      expect(prisma.orgUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1', revokedAt: null },
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].myRole).toBe('owner');
      expect(result[0].id).toBe('org-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('getOrg', () => {
    it('404s on a missing org', async () => {
      await expect(service.getOrg('nope')).rejects.toThrow(NotFoundException);
    });

    it('never selects reviewer identity for the org plane', async () => {
      prisma.organization.findUnique.mockResolvedValue(orgRow());
      await service.getOrg('org-1');
      const select = prisma.organization.findUnique.mock.calls[0][0].select;
      expect(select.reviewedBy).toBeUndefined();
      expect(select.reviewedAt).toBeUndefined();
      expect(select.riskTier).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('submitOrg', () => {
    it('submits a draft org with a CR number and audits it', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow({ status: 'draft' }),
      );
      await service.submitOrg('u1', 'org-1');
      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
          data: expect.objectContaining({
            status: 'submitted',
            submittedAt: expect.any(Date),
          }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'org.submit', targetId: 'org-1' }),
      );
    });

    it('allows resubmission from changes_requested', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow({ status: 'changes_requested' }),
      );
      await expect(service.submitOrg('u1', 'org-1')).resolves.toBeDefined();
    });

    it.each(['submitted', 'approved', 'rejected', 'suspended'])(
      'rejects submission from %s',
      async (status) => {
        prisma.organization.findUnique.mockResolvedValue(orgRow({ status }));
        await expect(service.submitOrg('u1', 'org-1')).rejects.toThrow(
          'org_not_submittable',
        );
        expect(prisma.organization.update).not.toHaveBeenCalled();
      },
    );

    it('requires a CR number before review', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow({ status: 'draft', crNumber: null }),
      );
      await expect(service.submitOrg('u1', 'org-1')).rejects.toThrow(
        'org_cr_required',
      );
    });

    it('404s on a missing org', async () => {
      await expect(service.submitOrg('u1', 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('reviewOrg', () => {
    const submitted = () =>
      prisma.organization.findUnique.mockResolvedValue(
        orgRow({ status: 'submitted' }),
      );

    it('rejects an unknown review action', async () => {
      submitted();
      await expect(
        service.reviewOrg('a1', 'org-1', 'suspend' as never, null),
      ).rejects.toThrow('org_review_action_invalid');
    });

    it.each(['reject', 'request_changes'] as const)(
      'requires a reason for %s',
      async (action) => {
        submitted();
        await expect(
          service.reviewOrg('a1', 'org-1', action, '   '),
        ).rejects.toThrow('org_review_reason_required');
      },
    );

    it('approve → approved, clears rejectionReason, stamps reviewer', async () => {
      submitted();
      await service.reviewOrg('a1', 'org-1', 'approve', null);
      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'approved',
            rejectionReason: null,
            reviewedBy: 'a1',
            reviewedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('reject → rejected with the reason stored verbatim (trimmed)', async () => {
      submitted();
      await service.reviewOrg('a1', 'org-1', 'reject', '  CR mismatch  ');
      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'rejected',
            rejectionReason: 'CR mismatch',
          }),
        }),
      );
    });

    it('request_changes → changes_requested (resubmittable)', async () => {
      submitted();
      await service.reviewOrg('a1', 'org-1', 'request_changes', 'Add VAT no.');
      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'changes_requested' }),
        }),
      );
    });

    it('409s when the org is not in submitted state', async () => {
      prisma.organization.findUnique.mockResolvedValue(
        orgRow({ status: 'approved' }),
      );
      try {
        await service.reviewOrg('a1', 'org-1', 'approve', null);
        throw new Error('expected reviewOrg to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(409);
        expect(
          ((e as HttpException).getResponse() as { code: string }).code,
        ).toBe('org_not_in_review');
      }
    });

    it('records admin.org.review with action + reason metadata', async () => {
      submitted();
      await service.reviewOrg('a1', 'org-1', 'reject', 'CR mismatch');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'a1',
          actorType: 'admin',
          action: 'admin.org.review',
          targetType: 'organization',
          targetId: 'org-1',
          metadata: { reviewAction: 'reject', reason: 'CR mismatch' },
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('listOrgsForReview', () => {
    it('filters by a known status', async () => {
      await service.listOrgsForReview('submitted');
      expect(prisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'submitted' } }),
      );
    });

    it('ignores an unknown status value (no filter injection)', async () => {
      await service.listOrgsForReview('<script>');
      expect(prisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });
});
