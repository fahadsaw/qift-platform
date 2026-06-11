// RosterPurgeService unit tests — Corporate Foundation PR 2.
//
// The sweeper is the enforcement half of the roster retention
// promise. Pinned here: the delete predicate (strictly past
// purgeAfter), the system audit row (count only, null actor), the
// never-throws posture, and the env gating (default OFF; test env
// never starts a timer).

import { RosterPurgeService } from './roster-purge.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

describe('RosterPurgeService', () => {
  let prisma: { corporateContact: { deleteMany: jest.Mock } };
  let audit: { record: jest.Mock };
  let service: RosterPurgeService;
  const ORIGINAL_FLAG = process.env.QIFT_ROSTER_PURGE_ENABLED;

  beforeEach(() => {
    prisma = {
      corporateContact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new RosterPurgeService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.QIFT_ROSTER_PURGE_ENABLED;
    else process.env.QIFT_ROSTER_PURGE_ENABLED = ORIGINAL_FLAG;
    service.onModuleDestroy();
    jest.clearAllMocks();
  });

  it('deletes rows strictly past purgeAfter', async () => {
    prisma.corporateContact.deleteMany.mockResolvedValue({ count: 3 });
    const res = await service.runOnce();
    expect(res).toEqual({ deleted: 3 });
    const { where } = prisma.corporateContact.deleteMany.mock.calls[0][0];
    expect(where.purgeAfter.lt).toBeInstanceOf(Date);
    expect(where.purgeAfter.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('audits a count-only system row when something was purged', async () => {
    prisma.corporateContact.deleteMany.mockResolvedValue({ count: 5 });
    await service.runOnce();
    expect(audit.record).toHaveBeenCalledWith({
      actorUserId: null,
      actorType: 'system',
      action: 'system.roster.purge',
      targetType: 'system',
      targetId: null,
      metadata: { deleted: 5 },
    });
  });

  it('stays silent (no audit) when nothing expired', async () => {
    await service.runOnce();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('never throws — a failed sweep logs and returns zero', async () => {
    prisma.corporateContact.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(service.runOnce()).resolves.toEqual({ deleted: 0 });
  });

  it('does not start a timer under NODE_ENV=test even with the flag on', () => {
    process.env.QIFT_ROSTER_PURGE_ENABLED = 'true';
    service.onModuleInit();
    expect(prisma.corporateContact.deleteMany).not.toHaveBeenCalled();
    expect((service as unknown as { timer: unknown }).timer).toBeNull();
  });
});
