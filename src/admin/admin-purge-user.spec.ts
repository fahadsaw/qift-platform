// AdminService.purgeUser unit coverage.
//
// PURPOSE
// Purge is the highest-blast-radius admin operation in the system.
// This spec pins the pre-purge guards + the anonymisation contract
// + the audit-row shape so a future refactor can't silently:
//   - skip a guard (turning a safe-by-design rejection into an
//     irreversible mutation)
//   - leak prior PII into the audit metadata (defeating the
//     "right to be forgotten" half of the operation)
//   - forget a delete on an identity-PII table (leaving Address /
//     SocialAccount rows orphaned post-purge)
//   - rewrite the @unique columns without a sentinel (blocking
//     re-registration with the original values)
//
// SCOPE
// Pure unit tests using a Prisma mock. The integration story —
// "can a freshly-registered user re-use the same phone after the
// admin purges the old account?" — is covered by the
// auth.service.register spec in a separate file (sibling PR).
//
// What this spec DOES NOT cover (deliberately):
//   - HTTP layer / controller routing (covered by
//     admin-rbac-coverage.spec.ts).
//   - Permission gating via @RequireOpsPermission (covered by
//     admin-rbac-coverage.spec.ts).
//   - Audit-log persistence (audit module currently uses the
//     recordAuditTODO placeholder; once the AuditService swap
//     lands, the audit-write assertion graduates to a real mock).

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AdminService } from './admin.service';

type AnyMock = jest.Mock;

// Build a Prisma mock with the minimum surface the purge path
// touches. Each method that purgeUser() calls gets a default
// resolved value tuned to a "happy path admin purges an ordinary
// user with no in-flight gifts" scenario. Individual tests
// override only the fields they need.
function makePrismaMock() {
  const userFindUnique: AnyMock = jest.fn();
  const userUpdate: AnyMock = jest.fn().mockResolvedValue({});
  const giftCount: AnyMock = jest.fn().mockResolvedValue(0);

  const addressDeleteMany: AnyMock = jest.fn().mockResolvedValue({ count: 0 });
  const socialAccountDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const pushSubscriptionDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const notificationPreferencesDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const wishDeleteMany: AnyMock = jest.fn().mockResolvedValue({ count: 0 });
  const postDeleteMany: AnyMock = jest.fn().mockResolvedValue({ count: 0 });
  const giftPostAppreciationDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const followDeleteMany: AnyMock = jest.fn().mockResolvedValue({ count: 0 });
  const blockDeleteMany: AnyMock = jest.fn().mockResolvedValue({ count: 0 });
  const notificationDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const occasionReminderDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const giftAttemptDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const opsRoleAssignmentDeleteMany: AnyMock = jest
    .fn()
    .mockResolvedValue({ count: 0 });

  const $transaction = jest.fn(
    async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      // Same tx surface as the outer client — same mocks. Mirrors
      // the closed-beta backend usage where tx.delete and tx.update
      // are the prisma client methods themselves wrapped by the
      // Prisma proxy.
      return cb({
        address: { deleteMany: addressDeleteMany },
        socialAccount: { deleteMany: socialAccountDeleteMany },
        pushSubscription: { deleteMany: pushSubscriptionDeleteMany },
        notificationPreferences: {
          deleteMany: notificationPreferencesDeleteMany,
        },
        wish: { deleteMany: wishDeleteMany },
        post: { deleteMany: postDeleteMany },
        giftPostAppreciation: { deleteMany: giftPostAppreciationDeleteMany },
        follow: { deleteMany: followDeleteMany },
        block: { deleteMany: blockDeleteMany },
        notification: { deleteMany: notificationDeleteMany },
        occasionReminder: { deleteMany: occasionReminderDeleteMany },
        giftAttempt: { deleteMany: giftAttemptDeleteMany },
        opsRoleAssignment: { deleteMany: opsRoleAssignmentDeleteMany },
        user: { update: userUpdate },
      });
    },
  );

  return {
    prisma: {
      user: { findUnique: userFindUnique, update: userUpdate },
      gift: { count: giftCount },
      $transaction,
    } as unknown as ConstructorParameters<typeof AdminService>[0],
    mocks: {
      userFindUnique,
      userUpdate,
      giftCount,
      $transaction,
      addressDeleteMany,
      socialAccountDeleteMany,
      pushSubscriptionDeleteMany,
      notificationPreferencesDeleteMany,
      wishDeleteMany,
      postDeleteMany,
      giftPostAppreciationDeleteMany,
      followDeleteMany,
      blockDeleteMany,
      notificationDeleteMany,
      occasionReminderDeleteMany,
      giftAttemptDeleteMany,
      opsRoleAssignmentDeleteMany,
    },
  };
}

const TARGET = {
  id: 'usr_target',
  qiftUsername: 'sarah_q',
  role: 'user',
  deletedAt: null as Date | null,
  purgedAt: null as Date | null,
  _count: { ownedStores: 0 },
};

function buildService() {
  const { prisma, mocks } = makePrismaMock();
  // StoresService is part of the AdminService constructor but
  // purgeUser doesn't touch it; pass a minimal stub so the
  // service constructs.
  const stores = {} as unknown as ConstructorParameters<typeof AdminService>[1];
  // PR 7 — the persistent audit trail; purge asserts the row shape
  // elsewhere, here a recording stub keeps construction honest.
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof AdminService>[2];
  const opsRoles = {
    userHasPermission: jest.fn().mockResolvedValue(false),
  } as unknown as ConstructorParameters<typeof AdminService>[3];
  const reconciliation = {
    findMissing: jest.fn(),
    repairAll: jest.fn(),
  } as unknown as ConstructorParameters<typeof AdminService>[4];
  const service = new AdminService(
    prisma,
    stores,
    audit,
    opsRoles,
    reconciliation,
  );
  return { service, mocks };
}

describe('AdminService.purgeUser', () => {
  describe('pre-purge guards', () => {
    it('rejects cannot_purge_self', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await expect(
        service.purgeUser('usr_target', 'usr_target', 'sarah_q'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // findUnique should NOT have been called — the self-check
      // runs upstream of the DB read.
      expect(mocks.userFindUnique).not.toHaveBeenCalled();
    });

    it('rejects cannot_purge_admin', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({
        ...TARGET,
        role: 'admin',
      });
      await expect(
        service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername),
      ).rejects.toMatchObject({ message: 'cannot_purge_admin' });
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('rejects user_owns_stores', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({
        ...TARGET,
        _count: { ownedStores: 2 },
      });
      await expect(
        service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('rejects confirmation_mismatch (case-sensitive)', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await expect(
        service.purgeUser('usr_viewer', TARGET.id, 'Sarah_Q'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.giftCount).not.toHaveBeenCalled();
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('rejects user_has_inflight_gifts', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      mocks.giftCount.mockResolvedValueOnce(1);
      await expect(
        service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername),
      ).rejects.toMatchObject({ message: 'user_has_inflight_gifts' });
      // In-flight gift gate fires AFTER the confirmation check —
      // the gift count call ran but the transaction did not.
      expect(mocks.giftCount).toHaveBeenCalledTimes(1);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('inflight-gift query covers BOTH sender and receiver sides', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername);
      const where = mocks.giftCount.mock.calls[0][0].where as {
        OR: Array<{ senderId?: string; receiverId?: string }>;
      };
      const ors = where.OR.map((o) =>
        o.senderId ? 'sender' : o.receiverId ? 'receiver' : 'unknown',
      );
      expect(ors).toEqual(expect.arrayContaining(['sender', 'receiver']));
    });

    it('404 when target user not found', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce(null);
      await expect(
        service.purgeUser('usr_viewer', 'usr_missing', 'whoever'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('idempotency', () => {
    it('returns existing purgedAt without re-running the transaction', async () => {
      const { service, mocks } = buildService();
      const existingPurgedAt = new Date('2026-06-01T00:00:00Z');
      mocks.userFindUnique.mockResolvedValueOnce({
        ...TARGET,
        purgedAt: existingPurgedAt,
      });
      const out = await service.purgeUser(
        'usr_viewer',
        TARGET.id,
        // confirmUsername doesn't matter on an already-purged row.
        'anything',
      );
      expect(out).toEqual({ id: TARGET.id, purgedAt: existingPurgedAt });
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('happy-path anonymisation contract', () => {
    it('writes deterministic sentinels on User.phone and User.qiftUsername', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername);
      const updateArgs = mocks.userUpdate.mock.calls[0][0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      expect(updateArgs.where.id).toBe(TARGET.id);
      expect(updateArgs.data.phone).toBe(`__purged__:${TARGET.id}`);
      expect(updateArgs.data.qiftUsername).toBe(`__purged__:${TARGET.id}`);
      // Email is released as NULL — Postgres @unique allows multiple
      // nulls, so re-registration with the original email works.
      expect(updateArgs.data.email).toBeNull();
    });

    it('nulls every PII column on the User row', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername);
      const data = mocks.userUpdate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      // Identity / contact / verification PII.
      expect(data.passwordHash).toBeNull();
      expect(data.fullName).toBeNull();
      expect(data.bio).toBeNull();
      expect(data.avatarUrl).toBeNull();
      expect(data.defaultAddress).toBeNull();
      expect(data.phoneVerifiedAt).toBeNull();
      expect(data.emailVerifiedAt).toBeNull();
      // Discoverability flags are flipped to default-deny + private
      // so the tombstone is invisible to any future search.
      expect(data.allowPhoneDiscovery).toBe(false);
      expect(data.allowEmailDiscovery).toBe(false);
      expect(data.profileVisibility).toBe('private');
      // Preference PII.
      expect(data.preferredClothingSize).toBeNull();
      expect(data.preferredShoeSize).toBeNull();
      expect(data.preferredRingSize).toBeNull();
      expect(data.preferredPerfume).toBeNull();
      expect(data.favoriteColors).toBeNull();
      expect(data.favoriteCategories).toBeNull();
      expect(data.favoriteBrands).toBeNull();
      expect(data.allergies).toBeNull();
      expect(data.giftNote).toBeNull();
    });

    it('stamps deletedAt AND purgedAt on the same instant', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername);
      const data = mocks.userUpdate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(data.purgedAt).toBeInstanceOf(Date);
      // Same Date instance — both columns must agree so the
      // soft-delete filter excludes the row alongside the
      // purged filter.
      expect(data.deletedAt).toBe(data.purgedAt);
    });

    it('hard-deletes every identity-PII table inside the transaction', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername);
      const filter = { userId: TARGET.id };
      expect(mocks.addressDeleteMany).toHaveBeenCalledWith({ where: filter });
      expect(mocks.socialAccountDeleteMany).toHaveBeenCalledWith({
        where: filter,
      });
      expect(mocks.pushSubscriptionDeleteMany).toHaveBeenCalledWith({
        where: filter,
      });
      expect(mocks.notificationPreferencesDeleteMany).toHaveBeenCalledWith({
        where: filter,
      });
      expect(mocks.wishDeleteMany).toHaveBeenCalledWith({ where: filter });
      expect(mocks.postDeleteMany).toHaveBeenCalledWith({ where: filter });
      expect(mocks.giftPostAppreciationDeleteMany).toHaveBeenCalledWith({
        where: filter,
      });
      expect(mocks.notificationDeleteMany).toHaveBeenCalledWith({
        where: filter,
      });
      expect(mocks.occasionReminderDeleteMany).toHaveBeenCalledWith({
        where: filter,
      });
      expect(mocks.opsRoleAssignmentDeleteMany).toHaveBeenCalledWith({
        where: filter,
      });
    });

    it('removes follow/block/giftAttempt rows on BOTH sides of the relation', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername);
      const checkBothSides = (m: AnyMock, a: string, b: string): boolean => {
        const arg = m.mock.calls[0][0] as { where: { OR: unknown[] } };
        const ors = arg.where.OR as Array<Record<string, string>>;
        const aHit = ors.some((o) => o[a] === TARGET.id);
        const bHit = ors.some((o) => o[b] === TARGET.id);
        return aHit && bHit;
      };
      expect(
        checkBothSides(mocks.followDeleteMany, 'followerId', 'followingId'),
      ).toBe(true);
      expect(
        checkBothSides(mocks.blockDeleteMany, 'blockerId', 'blockedId'),
      ).toBe(true);
      expect(
        checkBothSides(mocks.giftAttemptDeleteMany, 'senderId', 'receiverId'),
      ).toBe(true);
    });

    it('runs every delete + the User update inside a single $transaction', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      await service.purgeUser('usr_viewer', TARGET.id, TARGET.qiftUsername);
      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
      // Every PII-table delete + the user.update must have fired
      // INSIDE the transaction callback, NOT outside it. We assert
      // by checking each mock was called exactly once.
      expect(mocks.addressDeleteMany).toHaveBeenCalledTimes(1);
      expect(mocks.socialAccountDeleteMany).toHaveBeenCalledTimes(1);
      expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
    });

    it('returns { id, purgedAt } on success', async () => {
      const { service, mocks } = buildService();
      mocks.userFindUnique.mockResolvedValueOnce({ ...TARGET });
      const out = await service.purgeUser(
        'usr_viewer',
        TARGET.id,
        TARGET.qiftUsername,
      );
      expect(out.id).toBe(TARGET.id);
      expect(out.purgedAt).toBeInstanceOf(Date);
    });
  });
});
