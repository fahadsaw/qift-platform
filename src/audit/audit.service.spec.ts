// AuditService contract (PR 7).
//
//   - record() persists the row verbatim (actor / action / target /
//     metadata) to prisma.auditLog.
//   - null/omitted metadata maps to Prisma.JsonNull (a nullable JSON
//     column needs the sentinel, not JS null).
//   - record() NEVER throws — an audit hiccup must not unwind the
//     admin/user action that triggered it. Failures are logged.

import { Prisma } from '@prisma/client';
import { AuditService } from './audit.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('AuditService.record', () => {
  let create: jest.Mock;
  let service: AuditService;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({});
    service = new AuditService({
      auditLog: { create },
    } as unknown as PrismaService);
  });

  it('persists the row verbatim', async () => {
    await service.record({
      actorUserId: 'admin-1',
      actorType: 'admin',
      action: 'admin.user.role_change',
      targetType: 'user',
      targetId: 'usr-2',
      metadata: { fromRole: 'user', toRole: 'admin' },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        actorUserId: 'admin-1',
        actorType: 'admin',
        action: 'admin.user.role_change',
        targetType: 'user',
        targetId: 'usr-2',
        metadata: { fromRole: 'user', toRole: 'admin' },
      },
    });
  });

  it('maps missing metadata to Prisma.JsonNull', async () => {
    await service.record({
      actorUserId: 'usr-1',
      actorType: 'user',
      action: 'user.phone.change',
      targetType: 'user',
      targetId: 'usr-1',
    });

    const arg = create.mock.calls[0][0] as { data: { metadata: unknown } };
    expect(arg.data.metadata).toBe(Prisma.JsonNull);
  });

  it('NEVER throws — a failed write is swallowed and logged', async () => {
    create.mockRejectedValue(new Error('db down'));

    await expect(
      service.record({
        actorUserId: 'admin-1',
        actorType: 'admin',
        action: 'admin.user.disable',
        targetType: 'user',
        targetId: 'usr-2',
      }),
    ).resolves.toBeUndefined();
  });
});
