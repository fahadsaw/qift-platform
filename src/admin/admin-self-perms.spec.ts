// GET /admin/me/ops-roles contract (PR 10 — permission-aware UI).
//
//   - Returns the viewer's roles verbatim from OpsRolesService.
//   - Returns the SERVER-computed effective permission set (the
//     frontend must never re-derive role→permission from its own
//     catalog copy — drift would render the wrong buttons).
//   - super_admin resolves to every permission in the catalog.
//   - An admin with no ops roles gets empty arrays (UI renders
//     read-only surfaces), never an error.

import { AdminController } from './admin.controller';
import { OPS_PERMISSIONS } from '../ops-roles/ops-roles';
import type { AdminService } from './admin.service';
import type { OpsRolesService } from '../ops-roles/ops-roles.service';

function makeController(roles: string[]) {
  const opsRoles = {
    getUserRoles: jest.fn().mockResolvedValue(roles),
  } as unknown as OpsRolesService;
  const controller = new AdminController(
    {} as unknown as AdminService,
    opsRoles,
    {} as unknown as ConstructorParameters<typeof AdminController>[2],
    {} as unknown as ConstructorParameters<typeof AdminController>[3],
    {} as unknown as ConstructorParameters<typeof AdminController>[4],
    {} as unknown as ConstructorParameters<typeof AdminController>[5],
    {} as unknown as ConstructorParameters<typeof AdminController>[6],
    {} as unknown as ConstructorParameters<typeof AdminController>[7],
    {} as unknown as ConstructorParameters<typeof AdminController>[8],
  );
  return { controller, opsRoles };
}

const req = { user: { userId: 'admin-1', qiftUsername: 'fahad' } };

describe('GET /admin/me/ops-roles', () => {
  it('returns roles + server-computed permissions for a scoped role', async () => {
    const { controller } = makeController(['merchant_review']);

    const result = await controller.myOpsRoles(req);

    expect(result.roles).toEqual(['merchant_review']);
    expect(result.permissions).toEqual(
      expect.arrayContaining(['store.review']),
    );
    // A scoped role must NOT resolve to the full catalog.
    expect(result.permissions.length).toBeLessThan(OPS_PERMISSIONS.length);
    expect(result.permissions).not.toContain('user.purge');
  });

  it('super_admin resolves to the full permission catalog', async () => {
    const { controller } = makeController(['super_admin']);

    const result = await controller.myOpsRoles(req);

    expect(result.permissions).toHaveLength(OPS_PERMISSIONS.length);
    expect(result.permissions).toEqual(
      expect.arrayContaining(['user.purge', 'beta.manage', 'store.review']),
    );
  });

  it('an admin with no ops roles gets empty arrays, not an error', async () => {
    const { controller } = makeController([]);

    const result = await controller.myOpsRoles(req);

    expect(result).toEqual({ roles: [], permissions: [] });
  });

  it('asks OpsRolesService about the VIEWER, not a route param', async () => {
    const { controller, opsRoles } = makeController([]);

    await controller.myOpsRoles(req);

    expect(opsRoles.getUserRoles).toHaveBeenCalledWith('admin-1');
  });
});
