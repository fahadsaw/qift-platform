// GET /admin/audit-log shaping contract (PR 11 — read-only viewer).
//
//   - Newest-first, default take 50, clamped to [1, 100].
//   - actor filters by exact id; action by PREFIX (family browse);
//     targetType by exact value; before by createdAt < cursor.
//   - Blank/invalid filters are dropped, never passed to Prisma.

import { AdminService } from './admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StoresService } from '../stores/stores.service';
import type { AuditService } from '../audit/audit.service';

function makeService() {
  const findMany = jest.fn().mockResolvedValue([]);
  const service = new AdminService(
    { auditLog: { findMany } } as unknown as PrismaService,
    {} as unknown as StoresService,
    {} as unknown as AuditService,
  );
  return { service, findMany };
}

describe('AdminService.listAuditLog', () => {
  it('defaults: no filters, newest-first, take 50', async () => {
    const { service, findMany } = makeService();
    await service.listAuditLog({});
    expect(findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('composes actor (exact), action (prefix), targetType, before', async () => {
    const { service, findMany } = makeService();
    await service.listAuditLog({
      actor: ' admin-1 ',
      action: 'admin.store',
      targetType: 'store',
      before: '2026-06-10T00:00:00.000Z',
    });
    const arg = findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(arg.where.actorUserId).toBe('admin-1');
    expect(arg.where.action).toEqual({ startsWith: 'admin.store' });
    expect(arg.where.targetType).toBe('store');
    expect(arg.where.createdAt).toEqual({
      lt: new Date('2026-06-10T00:00:00.000Z'),
    });
  });

  it('clamps take into [1, 100]', async () => {
    const { service, findMany } = makeService();
    await service.listAuditLog({ take: 9999 });
    expect(findMany.mock.calls[0][0].take).toBe(100);
    await service.listAuditLog({ take: -5 });
    expect(findMany.mock.calls[1][0].take).toBe(1);
  });

  it('drops blank and invalid filters', async () => {
    const { service, findMany } = makeService();
    await service.listAuditLog({
      actor: '  ',
      action: '',
      targetType: ' ',
      before: 'not-a-date',
    });
    expect(findMany.mock.calls[0][0].where).toEqual({});
  });
});
