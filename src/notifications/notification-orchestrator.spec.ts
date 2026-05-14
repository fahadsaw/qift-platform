// Tests for the NotificationOrchestrator. Locks down the
// decision-flow integration:
//   - mandatory categories bypass everything
//   - opt-out is honored only for non-mandatory categories
//   - budget caps queue alerts for digest while writing the row
//   - quiet hours queue alerts for digest while writing the row
//   - happy path writes the row + fires push
//
// We mock PrismaService + PushService so the spec is pure-CPU.
// The pure helpers (categories / quiet hours / budget) have
// their own unit specs; this spec proves they wire together
// correctly.

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- jest mocks are intentionally `any`-typed inside test files; the production code is fully typed. */

import { Test, type TestingModule } from '@nestjs/testing';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { NotificationCategory } from './notification-categories';
import { NotificationType } from './notifications.service';

type MockPrisma = {
  notification: {
    create: jest.Mock;
    count: jest.Mock;
  };
  notificationPreferences: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};

function createPrismaMock(): MockPrisma {
  const prisma: MockPrisma = {
    notification: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    notificationPreferences: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    // The orchestrator runs the two count queries inside a
    // transaction. We resolve to the mocked count return values
    // in order — daily then weekly.
    $transaction: jest.fn(),
  };
  // Default: both counts = 0 (well under any cap).
  prisma.$transaction.mockResolvedValue([0, 0]);
  return prisma;
}

const USER_ID = 'user_1';

describe('NotificationOrchestrator', () => {
  let service: NotificationOrchestrator;
  let prisma: MockPrisma;
  let push: { sendToUser: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    push = { sendToUser: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationOrchestrator,
        { provide: PrismaService, useValue: prisma },
        { provide: PushService, useValue: push },
      ],
    }).compile();

    service = module.get<NotificationOrchestrator>(NotificationOrchestrator);

    // Default: notification.create returns a fake row carrying the
    // data it was passed (so we can assert on row.id + pushDeliveredAt).
    prisma.notification.create.mockImplementation(({ data }: { data: any }) =>
      Promise.resolve({
        id: 'notif_1',
        ...data,
      }),
    );
  });

  describe('mandatory categories', () => {
    it('Security sends real-time, ignoring opt-outs', async () => {
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        userId: USER_ID,
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
        quietHoursTimezone: 'Asia/Riyadh',
        // User opted out of EVERYTHING — Security still fires.
        categoryOptOuts: { security: true, otp: true, legal: true },
        digestEnabled: true,
        digestFrequency: 'daily',
      });
      const out = await service.enqueue({
        userId: USER_ID,
        type: 'security.new_device_login',
        title: 'New sign-in detected',
        category: NotificationCategory.Security,
      });
      expect(out.kind).toBe('sent');
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      const row = prisma.notification.create.mock.calls[0][0];
      expect(row.data.category).toBe('security');
      expect(row.data.priority).toBe('critical');
      expect(row.data.pushDeliveredAt).toBeInstanceOf(Date);
      // Push is fire-and-forget; we still expect it was called.
      expect(push.sendToUser).toHaveBeenCalledTimes(1);
    });

    it('Legal sends real-time even under "always quiet" mute', async () => {
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        userId: USER_ID,
        // 00:00 → 00:00 = always quiet.
        quietHoursStart: '00:00',
        quietHoursEnd: '00:00',
        quietHoursTimezone: 'Asia/Riyadh',
        categoryOptOuts: {},
        digestEnabled: true,
        digestFrequency: 'daily',
      });
      const out = await service.enqueue({
        userId: USER_ID,
        type: 'legal.terms_update',
        title: 'Updated terms',
        category: NotificationCategory.Legal,
      });
      expect(out.kind).toBe('sent');
      expect(push.sendToUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('opt-out path (non-mandatory)', () => {
    it('suppresses without writing a row when user opted out', async () => {
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        userId: USER_ID,
        quietHoursStart: null,
        quietHoursEnd: null,
        quietHoursTimezone: 'Asia/Riyadh',
        categoryOptOuts: { social: true },
        digestEnabled: true,
        digestFrequency: 'daily',
      });
      const out = await service.enqueue({
        userId: USER_ID,
        type: NotificationType.GiftPostAppreciated,
        title: 'Someone appreciated your gift',
      });
      expect(out).toEqual({
        kind: 'suppressed',
        category: NotificationCategory.Social,
        reason: 'user_opted_out',
      });
      // CRITICAL: no row written, no push sent.
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(push.sendToUser).not.toHaveBeenCalled();
    });
  });

  describe('budget cap path (queue for digest)', () => {
    it('writes row with pushDeliveredAt=null when daily cap exceeded', async () => {
      // GiftUpdate category has dailyCap=20.
      prisma.$transaction.mockResolvedValueOnce([20, 30]);
      const out = await service.enqueue({
        userId: USER_ID,
        type: NotificationType.GiftReceived,
        title: 'Gift received',
      });
      expect(out.kind).toBe('queued_for_digest');
      expect(out).toMatchObject({
        category: NotificationCategory.GiftUpdate,
        reason: 'daily_cap_exceeded',
      });
      // The in-app row IS written — only the alert channels defer.
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      const row = prisma.notification.create.mock.calls[0][0];
      expect(row.data.pushDeliveredAt).toBeNull();
      // Push not fired.
      expect(push.sendToUser).not.toHaveBeenCalled();
    });
  });

  describe('quiet-hours path', () => {
    it('writes row with pushDeliveredAt=null when in quiet hours', async () => {
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce({
        userId: USER_ID,
        // 00:00 → 00:00 = always quiet (simplifies the test).
        quietHoursStart: '00:00',
        quietHoursEnd: '00:00',
        quietHoursTimezone: 'Asia/Riyadh',
        categoryOptOuts: {},
        digestEnabled: true,
        digestFrequency: 'daily',
      });
      const out = await service.enqueue({
        userId: USER_ID,
        type: NotificationType.GiftReceived,
        title: 'Gift received',
      });
      expect(out.kind).toBe('queued_for_digest');
      expect(out).toMatchObject({
        category: NotificationCategory.GiftUpdate,
        reason: 'quiet_hours',
      });
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      const row = prisma.notification.create.mock.calls[0][0];
      expect(row.data.pushDeliveredAt).toBeNull();
      expect(push.sendToUser).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('writes row with pushDeliveredAt=now and fires push', async () => {
      // No preferences row → all defaults (no opt-outs, no quiet
      // hours, digest enabled).
      // Counts at zero (well under cap).
      const fixedNow = new Date('2026-05-15T12:00:00.000Z');
      const out = await service.enqueue({
        userId: USER_ID,
        type: NotificationType.GiftReceived,
        title: 'Gift received',
        body: 'You received a gift',
        link: '/gifts/abc',
        now: fixedNow,
      });
      expect(out.kind).toBe('sent');
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      const row = prisma.notification.create.mock.calls[0][0];
      expect(row.data.userId).toBe(USER_ID);
      expect(row.data.type).toBe(NotificationType.GiftReceived);
      expect(row.data.title).toBe('Gift received');
      expect(row.data.body).toBe('You received a gift');
      expect(row.data.link).toBe('/gifts/abc');
      expect(row.data.category).toBe(NotificationCategory.GiftUpdate);
      expect(row.data.priority).toBe('high');
      expect(row.data.pushDeliveredAt).toEqual(fixedNow);
      expect(push.sendToUser).toHaveBeenCalledTimes(1);
      expect(push.sendToUser).toHaveBeenCalledWith(USER_ID, {
        title: 'Gift received',
        body: 'You received a gift',
        url: '/gifts/abc',
        type: NotificationType.GiftReceived,
      });
    });

    it('handles missing preferences row (defaults to no overrides)', async () => {
      prisma.notificationPreferences.findUnique.mockResolvedValueOnce(null);
      const out = await service.enqueue({
        userId: USER_ID,
        type: NotificationType.GiftReceived,
        title: 'Gift received',
      });
      expect(out.kind).toBe('sent');
    });
  });

  describe('resilience', () => {
    it('returns suppressed (db_error) when notification.create throws', async () => {
      prisma.notification.create.mockRejectedValueOnce(new Error('db down'));
      const out = await service.enqueue({
        userId: USER_ID,
        type: NotificationType.GiftReceived,
        title: 'Gift received',
      });
      expect(out).toEqual({
        kind: 'suppressed',
        category: NotificationCategory.GiftUpdate,
        reason: 'db_error',
      });
      // Push must NOT fire when the row write fails — the
      // user-facing record-of-truth is the Notification row.
      expect(push.sendToUser).not.toHaveBeenCalled();
    });
  });
});
