import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationsService,
  NotificationType,
} from '../notifications/notifications.service';

// Country-specific address schemas: every country uses the same table,
// but the *required* fields vary. We accept the full superset and just
// validate per-country here. Fields not relevant to a given country are
// stored as null.
export type AddressInput = {
  label?: string | null;
  country?: string;
  region?: string | null;
  city?: string;
  governorate?: string | null;
  district?: string;
  street?: string | null;
  buildingNumber?: string | null;
  unitNumber?: string | null;
  postalCode?: string | null;
  additionalNumber?: string | null;
  shortAddress?: string | null;
  deliveryPhone?: string | null;
  lat?: number | null;
  lng?: number | null;
  details?: string;
  isDefault?: boolean;
};

const FORBIDDEN_MSG = 'غير مصرح لك';

const ADDRESS_SELECT = {
  id: true,
  userId: true,
  label: true,
  country: true,
  region: true,
  city: true,
  governorate: true,
  district: true,
  street: true,
  buildingNumber: true,
  unitNumber: true,
  postalCode: true,
  additionalNumber: true,
  shortAddress: true,
  deliveryPhone: true,
  lat: true,
  lng: true,
  details: true,
  isDefault: true,
};

// Per-country required fields. The matrix lives here (server-side) so a
// malicious client can't bypass it by editing the frontend.
// Required fields per country. Tuned to match each country's
// real-world address conventions:
//   - Saudi Arabia: postal code is OPTIONAL. The Saudi National
//     Address scheme makes it derivable from the short address
//     (4-letter + 4-digit code), so requiring it on the form would
//     block users who only know their short code. The column is
//     still in the schema and surfaced once known (manually or via
//     SPL autofill).
const REQUIRED_BY_COUNTRY: Record<string, Array<keyof AddressInput>> = {
  SA: ['city', 'district', 'street', 'buildingNumber'],
  KW: ['city', 'district', 'street', 'buildingNumber'],
  AE: ['city', 'district', 'street', 'buildingNumber'],
  QA: ['city', 'district', 'street', 'buildingNumber'],
  BH: ['city', 'district', 'street', 'buildingNumber'],
  OM: ['city', 'district', 'street', 'buildingNumber'],
};

function normalizeCountry(c?: string) {
  return (c ?? '').trim().toUpperCase();
}

function s(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

@Injectable()
export class AddressesService {
  private readonly logger = new Logger(AddressesService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // Resolve outstanding GiftAttempt rows for `receiverUserId` and notify
  // each unique sender that the receiver is now ready. Idempotent:
  // attempts are flagged with `notifiedAt` + `resolvedAt`, so a future
  // address change won't re-notify.
  //
  // Called from every code path that brings the user into the "has a
  // default address" state — first address create, address-update-with-
  // isDefault, explicit setDefault, and the auto-promote in remove().
  // Errors are logged and swallowed: the user-facing address mutation
  // is what matters; the notification is best-effort.
  private async resolvePendingAttemptsFor(receiverUserId: string) {
    try {
      const attempts = await this.prisma.giftAttempt.findMany({
        where: { receiverId: receiverUserId, resolvedAt: null },
        select: { id: true, senderId: true },
      });
      if (attempts.length === 0) return;

      // Dedupe per sender — if a sender tried 3 times we only ping once.
      // We still flip every row to resolved so the dedupe state lives in
      // the DB rather than in memory.
      const uniqueSenderIds = Array.from(
        new Set(attempts.map((a) => a.senderId)),
      );
      const ids = attempts.map((a) => a.id);
      const now = new Date();

      // Mark all matching attempts resolved in one shot. Doing this BEFORE
      // notifying avoids double-notification under the (tiny) race where
      // two address writes land within the notification call window.
      await this.prisma.giftAttempt.updateMany({
        where: { id: { in: ids } },
        data: { notifiedAt: now, resolvedAt: now },
      });

      for (const senderId of uniqueSenderIds) {
        void this.notifications.trigger({
          userId: senderId,
          type: NotificationType.GiftAddressReadyForRetry,
          title:
            'الشخص الذي كنت تريد إرسال هدية له حدد عنوانًا افتراضيًا، يمكنك الآن إرسال الهدية',
          body: null,
          link: '/send',
        });
      }
    } catch (err) {
      // Address mutation already committed — don't bubble. Log for ops.
      this.logger.warn(
        `resolvePendingAttemptsFor(${receiverUserId}) failed: ${(err as Error).message}`,
      );
    }
  }

  // Validate + normalize the body. Returns a clean Prisma payload.
  private buildPayload(body: AddressInput) {
    const country = normalizeCountry(body.country);
    if (!country) throw new BadRequestException('country is required');

    const city = s(body.city);
    const district = s(body.district);
    const details = s(body.details) ?? '';
    const required = REQUIRED_BY_COUNTRY[country];

    if (required) {
      // For known countries enforce the country-specific shape.
      const candidate: Record<string, string | null> = {
        city,
        district,
        street: s(body.street),
        buildingNumber: s(body.buildingNumber),
        postalCode: s(body.postalCode),
      };
      for (const field of required) {
        if (!candidate[field as string]) {
          throw new BadRequestException(`${field} is required for ${country}`);
        }
      }
    } else {
      // Unknown / "Other" country still needs *some* locator.
      if (!city || !district) {
        throw new BadRequestException('city and district are required');
      }
    }

    return {
      label: s(body.label),
      country,
      region: s(body.region),
      city: city ?? '',
      governorate: s(body.governorate),
      district: district ?? '',
      street: s(body.street),
      buildingNumber: s(body.buildingNumber),
      unitNumber: s(body.unitNumber),
      postalCode: s(body.postalCode),
      additionalNumber: s(body.additionalNumber),
      shortAddress: s(body.shortAddress),
      deliveryPhone: s(body.deliveryPhone),
      lat: num(body.lat),
      lng: num(body.lng),
      details,
    };
  }

  // Create. If this is the user's first address (or `isDefault` was passed),
  // it becomes the default and we clear any previous default in a single tx
  // so the invariant "at most one default per user" always holds.
  async create(viewerUserId: string, body: AddressInput) {
    const payload = this.buildPayload(body);
    const existing = await this.prisma.address.count({
      where: { userId: viewerUserId },
    });
    // Whether the user had ANY default before this call. We use this to
    // decide whether to fire the "address ready for retry" notification:
    // only when this call moves the user from "no default" → "has
    // default" do we notify pending senders. Subsequent default swaps
    // don't re-trigger.
    const hadDefaultBefore =
      existing > 0 &&
      (await this.prisma.address.count({
        where: { userId: viewerUserId, isDefault: true },
      })) > 0;
    const wantsDefault = body.isDefault === true || existing === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      if (wantsDefault) {
        await tx.address.updateMany({
          where: { userId: viewerUserId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.create({
        data: {
          ...payload,
          userId: viewerUserId,
          isDefault: wantsDefault,
        },
        select: ADDRESS_SELECT,
      });
    });

    // Edge transition: this is the user's first default address. Resolve
    // any pending GiftAttempt rows and notify the senders that they can
    // now retry.
    if (wantsDefault && !hadDefaultBefore) {
      void this.resolvePendingAttemptsFor(viewerUserId);
    }

    return created;
  }

  findByUser(viewerUserId: string, requestedUserId: string) {
    if (viewerUserId !== requestedUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return this.prisma.address.findMany({
      where: { userId: requestedUserId },
      select: ADDRESS_SELECT,
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
  }

  // Convenience for the logged-in viewer: skip the userId param.
  listMine(viewerUserId: string) {
    return this.findByUser(viewerUserId, viewerUserId);
  }

  async update(viewerUserId: string, addressId: string, body: AddressInput) {
    const existing = await this.prisma.address.findUnique({
      where: { id: addressId },
      select: { userId: true, isDefault: true },
    });
    if (!existing) throw new NotFoundException('Address not found');
    if (existing.userId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    const payload = this.buildPayload(body);
    const wantsDefault = body.isDefault === true;

    // Pre-mutation snapshot of "did the user already have a default?".
    // If they did, this update is just a default-swap and we don't
    // re-notify. Only the no-default → has-default transition triggers
    // resolvePendingAttemptsFor.
    const hadDefaultBefore =
      (await this.prisma.address.count({
        where: { userId: viewerUserId, isDefault: true },
      })) > 0;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (wantsDefault && !existing.isDefault) {
        await tx.address.updateMany({
          where: { userId: viewerUserId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.update({
        where: { id: addressId },
        data: {
          ...payload,
          // Only flip default upward; clearing the only default is handled
          // explicitly via the dedicated setDefault endpoint or by deletion.
          isDefault: wantsDefault ? true : existing.isDefault,
        },
        select: ADDRESS_SELECT,
      });
    });

    if (wantsDefault && !hadDefaultBefore) {
      void this.resolvePendingAttemptsFor(viewerUserId);
    }

    return updated;
  }

  // Promote a specific address to default and clear the others. This is
  // the canonical way to switch defaults from the UI.
  async setDefault(viewerUserId: string, addressId: string) {
    const existing = await this.prisma.address.findUnique({
      where: { id: addressId },
      select: { userId: true },
    });
    if (!existing) throw new NotFoundException('Address not found');
    if (existing.userId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }

    // Same edge-detection as create()/update(): only fire the retry
    // notification when this call moves the user from "no default" to
    // "has default". Pure swaps don't re-notify.
    const hadDefaultBefore =
      (await this.prisma.address.count({
        where: { userId: viewerUserId, isDefault: true },
      })) > 0;

    const promoted = await this.prisma.$transaction(async (tx) => {
      await tx.address.updateMany({
        where: { userId: viewerUserId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.address.update({
        where: { id: addressId },
        data: { isDefault: true },
        select: ADDRESS_SELECT,
      });
    });

    if (!hadDefaultBefore) {
      void this.resolvePendingAttemptsFor(viewerUserId);
    }

    return promoted;
  }

  // Delete with auto-promote: if the deleted address was the default and
  // the user still has other addresses, promote the most recent one. If no
  // addresses remain, the user becomes "suspended" (no default), which is
  // computed live by users.getProfile.
  async remove(viewerUserId: string, addressId: string) {
    const existing = await this.prisma.address.findUnique({
      where: { id: addressId },
      select: { userId: true, isDefault: true },
    });
    if (!existing) throw new NotFoundException('Address not found');
    if (existing.userId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id: addressId } });
      if (existing.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId: viewerUserId },
          orderBy: { id: 'desc' },
          select: { id: true },
        });
        if (next) {
          await tx.address.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
        }
      }
      return { ok: true };
    });
  }
}
