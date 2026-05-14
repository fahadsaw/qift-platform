import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isMerchantPlan,
  planHas,
  type MerchantCapability,
} from './merchant-plans';
import {
  STOREFRONT_THEME_SLUGS,
  isStorefrontThemeSlug,
  isThemeEligible,
  sanitizeThemeConfig,
  sanitizeMetricsVisibility,
} from './storefront-themes';

const FORBIDDEN_MSG = 'غير مصرح لك';

// Public-facing fields. Notably excludes `webhookSecret` so the secret
// never leaks via list/detail endpoints — it's only ever returned from
// the explicit /store-integrations/connect call to the owner.
//
// Onboarding-v2 fields included in the public projection are non-
// sensitive (branding, social, store-name etc.). Verification-doc
// rows + rejectionReason ride a separate select used only on the
// owner's own /stores/:id endpoint and the admin review surface.
const PUBLIC_STORE_SELECT = {
  id: true,
  name: true,
  city: true,
  category: true,
  integrationType: true,
  integrationStatus: true,
  ownerId: true,
  createdAt: true,
  status: true,
  plan: true,
  featured: true,
  logoUrl: true,
  coverImageUrl: true,
  websiteUrl: true,
  instagramHandle: true,
  tiktokHandle: true,
  snapchatHandle: true,
  // Storefront theme (Phase 5). themeSlug + themeConfig power the
  // server-side dispatcher; metricsVisibility powers the per-metric
  // opt-in sanitization in primitives. See
  // `project_storefront_architecture.md`.
  themeSlug: true,
  themeConfig: true,
  metricsVisibility: true,
} as const;

// Owner / admin select. Adds the merchant-application fields the
// owner needs to see on their pending-approval screen and that
// admins read on the review modal. Still excludes webhookSecret.
const OWNER_STORE_SELECT = {
  ...PUBLIC_STORE_SELECT,
  legalEntityName: true,
  countryOfRegistration: true,
  commercialRegistrationNumber: true,
  vatNumber: true,
  contactPerson: true,
  contactPhone: true,
  contactEmail: true,
  deliveryZones: true,
  rejectionReason: true,
  submittedAt: true,
  reviewedAt: true,
} as const;

// Application states. The string union widened from the original
// 4 (pending/approved/rejected/suspended) to the full onboarding-v2
// vocabulary. `pending` is kept as a legacy alias for `submitted`
// so pre-v2 stores don't suddenly read as a different state.
const VALID_STATUS_TRANSITIONS = new Set<string>([
  'draft',
  'submitted',
  'pending', // legacy alias
  'pending_review',
  'approved',
  'rejected',
  'changes_requested',
  'suspended',
]);

// Public-visibility allow-list. ONLY stores in one of these states
// surface on anonymous routes (GET /stores, GET /stores/:id) and
// through derived public surfaces (GET /products?storeId=,
// GET /products/:id). Every other status is owner-private:
//   - draft / submitted / pending_review / changes_requested →
//     pre-approval; the merchant sees these via /stores/me +
//     /store-dashboard but the public never does.
//   - rejected / suspended → operationally hidden; admin can still
//     reach them via /admin/*.
//
// 'approved' is the only forward-looking state. 'pending' is the
// legacy alias — pre-v2 stores were backfilled to 'approved', but
// keep it in the allow-list as belt-and-braces in case any
// integration path still writes the old value.
//
// Exported so ProductsService (and any future surface that joins
// against Store) can use the same filter — one source of truth
// for "what counts as a publicly-visible store".
export const PUBLIC_STORE_STATUSES = ['approved', 'pending'] as const;

export type CreateStoreInput = {
  name?: string;
  city?: string;
  category?: string;
  // All optional v2 fields can be supplied at create time too
  // (multi-step form may write them progressively).
  legalEntityName?: string;
  countryOfRegistration?: string;
  commercialRegistrationNumber?: string;
  vatNumber?: string;
  contactPerson?: string;
  contactPhone?: string;
  contactEmail?: string;
  websiteUrl?: string;
  instagramHandle?: string;
  tiktokHandle?: string;
  snapchatHandle?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  // Coverage zones — JSON array of { city, districts?, note? }.
  // Validated via the matchAddressToZones contract documented in
  // lib/deliveryZones.ts (frontend) and mirrored by the backend's
  // canDeliverTo path. Stored as Prisma's `Json` (Postgres JSONB).
  deliveryZones?: DeliveryZoneInput[];
};

export type UpdateStoreInput = {
  name?: string;
  city?: string;
  category?: string;
  // Mirrors CreateStoreInput. All optional — we PATCH only the
  // fields actually present on the body.
  legalEntityName?: string;
  countryOfRegistration?: string;
  commercialRegistrationNumber?: string;
  vatNumber?: string;
  contactPerson?: string;
  contactPhone?: string;
  contactEmail?: string;
  websiteUrl?: string;
  instagramHandle?: string;
  tiktokHandle?: string;
  snapchatHandle?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  deliveryZones?: DeliveryZoneInput[];
};

// Wire-shape for one coverage zone. Mirrors DeliveryZone in
// lib/deliveryZones.ts (frontend) so the matcher reads the same
// payload the merchant submits.
export type DeliveryZoneInput = {
  city?: string;
  districts?: string[];
  note?: string;
};

@Injectable()
export class StoresService {
  constructor(private prisma: PrismaService) {}

  // Owner = JWT viewer. Name + city + category are required because
  // every downstream surface (dashboard header, search, stock checks)
  // assumes those fields are non-empty.
  //
  // Side effect: the User's role is bumped to "store" so the UI can
  // surface the dashboard link without a separate ownership lookup. We
  // never demote the role on store deletion (a user can be reinstated
  // later), but we also never depend on it for authz — every mutation
  // re-checks ownership in the service layer.
  async create(viewerUserId: string, body: CreateStoreInput) {
    const name = body.name?.trim();
    const city = body.city?.trim();
    const category = body.category?.trim();
    if (!name || !city || !category) {
      throw new BadRequestException('name, city and category are required');
    }
    const zones = sanitizeZones(body.deliveryZones);

    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: {
          name,
          city,
          category,
          ownerId: viewerUserId,
          // New v2 fields — all NULL when omitted. Setting them at
          // create time lets the multi-step form short-circuit a
          // separate PATCH right after.
          legalEntityName: body.legalEntityName?.trim() || null,
          countryOfRegistration: body.countryOfRegistration?.trim() || null,
          commercialRegistrationNumber:
            body.commercialRegistrationNumber?.trim() || null,
          vatNumber: body.vatNumber?.trim() || null,
          contactPerson: body.contactPerson?.trim() || null,
          contactPhone: body.contactPhone?.trim() || null,
          contactEmail: body.contactEmail?.trim().toLowerCase() || null,
          websiteUrl: body.websiteUrl?.trim() || null,
          instagramHandle: body.instagramHandle?.trim() || null,
          tiktokHandle: body.tiktokHandle?.trim() || null,
          snapchatHandle: body.snapchatHandle?.trim() || null,
          logoUrl: body.logoUrl?.trim() || null,
          coverImageUrl: body.coverImageUrl?.trim() || null,
          // Prisma's nullable JSON column needs Prisma.DbNull to
          // explicitly write SQL NULL; passing JS `null` is a
          // runtime error. We emit Prisma.DbNull when there are no
          // zones (legacy single-city fallback applies) and the
          // raw array otherwise.
          deliveryZones:
            zones.length > 0
              ? (zones as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
          // Status default stays "pending" for new applications.
          // The merchant moves to "submitted" via /stores/:id/submit
          // when the form is fully filled.
        },
        select: PUBLIC_STORE_SELECT,
      });
      // Bump the user's role so the UI can render the right nav links.
      await tx.user.update({
        where: { id: viewerUserId },
        data: { role: 'store' },
      });
      return store;
    });
  }

  // Owner-side update. Accepts every v2 field; leaves everything
  // not present on the body untouched (PATCH semantics). When the
  // store is in 'changes_requested' status, calling update implicitly
  // moves it back to 'submitted' so the admin sees the resubmission
  // — keeps the merchant from being stuck waiting for a re-trigger.
  async patch(viewerUserId: string, storeId: string, body: UpdateStoreInput) {
    const existing = await this.assertOwner(viewerUserId, storeId);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.city !== undefined) data.city = body.city.trim();
    if (body.category !== undefined) data.category = body.category.trim();
    if (body.legalEntityName !== undefined)
      data.legalEntityName = body.legalEntityName.trim() || null;
    if (body.countryOfRegistration !== undefined)
      data.countryOfRegistration = body.countryOfRegistration.trim() || null;
    if (body.commercialRegistrationNumber !== undefined)
      data.commercialRegistrationNumber =
        body.commercialRegistrationNumber.trim() || null;
    if (body.vatNumber !== undefined)
      data.vatNumber = body.vatNumber.trim() || null;
    if (body.contactPerson !== undefined)
      data.contactPerson = body.contactPerson.trim() || null;
    if (body.contactPhone !== undefined)
      data.contactPhone = body.contactPhone.trim() || null;
    if (body.contactEmail !== undefined)
      data.contactEmail = body.contactEmail.trim().toLowerCase() || null;
    if (body.websiteUrl !== undefined)
      data.websiteUrl = body.websiteUrl.trim() || null;
    if (body.instagramHandle !== undefined)
      data.instagramHandle = body.instagramHandle.trim() || null;
    if (body.tiktokHandle !== undefined)
      data.tiktokHandle = body.tiktokHandle.trim() || null;
    if (body.snapchatHandle !== undefined)
      data.snapchatHandle = body.snapchatHandle.trim() || null;
    if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl.trim() || null;
    if (body.coverImageUrl !== undefined)
      data.coverImageUrl = body.coverImageUrl.trim() || null;
    if (body.deliveryZones !== undefined) {
      const zones = sanitizeZones(body.deliveryZones);
      // See create() for why Prisma.DbNull is required for nullable
      // JSON columns. Same pattern.
      data.deliveryZones = zones.length > 0 ? zones : Prisma.DbNull;
    }
    // Resubmission auto-flip: when an admin sent the application
    // back ('changes_requested'), the merchant editing the form
    // is the resubmit signal — flip status back to 'submitted' and
    // clear the rejectionReason so the admin gets a fresh review.
    if (existing.status === 'changes_requested') {
      data.status = 'submitted';
      data.rejectionReason = null;
      data.submittedAt = new Date();
    }
    return this.prisma.store.update({
      where: { id: storeId },
      data,
      select: OWNER_STORE_SELECT,
    });
  }

  // Owner submits the merchant application for admin review. Allowed
  // from 'draft' / 'pending' (legacy) / 'changes_requested'. Other
  // states (already submitted, approved, suspended) bounce.
  async submit(viewerUserId: string, storeId: string) {
    const store = await this.assertOwner(viewerUserId, storeId);
    if (
      store.status !== 'draft' &&
      store.status !== 'pending' &&
      store.status !== 'changes_requested'
    ) {
      throw new BadRequestException(
        `Cannot submit a store in status "${store.status}"`,
      );
    }
    return this.prisma.store.update({
      where: { id: storeId },
      data: {
        status: 'submitted',
        submittedAt: new Date(),
        // Clear any previous reviewer note now that the merchant
        // has resubmitted — admin will leave a fresh one if needed.
        rejectionReason: null,
      },
      select: OWNER_STORE_SELECT,
    });
  }

  // Admin review. Authorisation is the AdminGuard on the controller;
  // this service trusts the caller is an admin. Three actions:
  //   approve            → status = 'approved', clears rejectionReason
  //   reject             → status = 'rejected', stores rejectionReason
  //   request_changes    → status = 'changes_requested', stores reason
  // All three timestamp `reviewedAt` and record `reviewedBy`. Reason
  // is REQUIRED for reject + request_changes (frontend enforces but
  // the service double-checks).
  async review(
    adminUserId: string,
    storeId: string,
    action: 'approve' | 'reject' | 'request_changes',
    reason: string | null,
  ) {
    const existing = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Store not found');

    if (
      (action === 'reject' || action === 'request_changes') &&
      (!reason || reason.trim().length === 0)
    ) {
      throw new BadRequestException(
        'reason is required when rejecting or requesting changes',
      );
    }

    const nextStatus =
      action === 'approve'
        ? 'approved'
        : action === 'reject'
          ? 'rejected'
          : 'changes_requested';
    const trimmedReason = action === 'approve' ? null : reason!.trim();

    return this.prisma.store.update({
      where: { id: storeId },
      data: {
        status: nextStatus,
        rejectionReason: trimmedReason,
        reviewedAt: new Date(),
        reviewedBy: adminUserId,
      },
      select: OWNER_STORE_SELECT,
    });
  }

  // Admin-only plan assignment. Self-serve upgrades + subscription
  // billing are deliberately out of scope today; admins move
  // merchants between tiers manually. Side-effects of downgrades
  // (e.g. what happens to a Pro store's API integrations when
  // they're dropped to Starter) are intentionally not modeled
  // here — that's a future decision once a real downgrade is
  // requested.
  async setPlan(storeId: string, plan: string) {
    if (!isMerchantPlan(plan)) {
      throw new BadRequestException('plan must be starter | pro | enterprise');
    }
    const existing = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Store not found');
    return this.prisma.store.update({
      where: { id: storeId },
      data: { plan },
      select: OWNER_STORE_SELECT,
    });
  }

  // Marketplace featured toggle. Admin-only — the editorial /
  // earned-placement variants ride on top of the same column
  // and can layer additional rules without a schema change.
  async setFeatured(storeId: string, featured: boolean) {
    const existing = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Store not found');
    return this.prisma.store.update({
      where: { id: storeId },
      data: { featured },
      select: OWNER_STORE_SELECT,
    });
  }

  // ── Storefront theme (Phase 5) ──────────────────────────────
  //
  // Merchant-side: set the selected theme + optional bounded
  // branding overrides. Plan gating + config sanitization are
  // enforced server-side; the dashboard picker uses these for
  // optimistic UX but the authoritative check lives here.
  //
  // The stored `themeSlug` is NEVER reset on plan downgrade —
  // `resolveActiveTheme()` falls back to 'classic' at render time
  // until the plan is restored, then the stored choice resumes.
  async setStoreTheme(
    viewerUserId: string,
    storeId: string,
    body: {
      themeSlug?: string;
      themeConfig?: unknown; // sanitized by storefront-themes.ts
    },
  ) {
    await this.assertOwner(viewerUserId, storeId);
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, plan: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    const data: Prisma.StoreUpdateInput = {};

    if (body.themeSlug !== undefined) {
      const slug = String(body.themeSlug).trim();
      if (!isStorefrontThemeSlug(slug)) {
        throw new BadRequestException(
          `Unknown theme: ${slug}. Allowed: ${STOREFRONT_THEME_SLUGS.join(' | ')}`,
        );
      }
      if (!isThemeEligible(store.plan, slug)) {
        throw new ForbiddenException('هذه الواجهة تتطلب ترقية باقة المتجر');
      }
      data.themeSlug = slug;
    }

    if (body.themeConfig !== undefined) {
      // null clears all overrides; otherwise sanitize through
      // the allow-list. Unknown keys silently dropped. The cast
      // to `InputJsonValue` is safe because sanitizeThemeConfig
      // emits a known-shape object with primitive values plus a
      // bounded themeSpecific dict; Prisma's stricter
      // `InputJsonObject` rejects the open `Record<string,
      // unknown>` index signature even though the runtime
      // values are JSON-compatible.
      const sanitized = sanitizeThemeConfig(body.themeConfig);
      data.themeConfig =
        sanitized === null
          ? Prisma.JsonNull
          : (sanitized as Prisma.InputJsonValue);
    }

    if (Object.keys(data).length === 0) {
      // Nothing to do — return the current row.
      return this.prisma.store.findUnique({
        where: { id: storeId },
        select: PUBLIC_STORE_SELECT,
      });
    }

    return this.prisma.store.update({
      where: { id: storeId },
      data,
      select: PUBLIC_STORE_SELECT,
    });
  }

  // Per-metric publicity flags. Same opt-in pattern as the
  // user-side preferencesVisibility — every key defaults to
  // false (owner-only). The dashboard visibility page is the
  // intended caller; the storefront primitives consume the
  // sanitized projection produced by `applyMetricsVisibility()`
  // below, so themes never see hidden values.
  async setStoreMetricsVisibility(
    viewerUserId: string,
    storeId: string,
    dict: unknown,
  ) {
    await this.assertOwner(viewerUserId, storeId);
    const existing = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Store not found');
    const sanitized = sanitizeMetricsVisibility(dict);
    return this.prisma.store.update({
      where: { id: storeId },
      data: {
        metricsVisibility: sanitized === null ? Prisma.JsonNull : sanitized,
      },
      select: PUBLIC_STORE_SELECT,
    });
  }

  // Server-side capability gate. Throw ForbiddenException when a
  // store's plan doesn't include the requested capability —
  // protects feature endpoints from being called from the
  // dashboard of an under-tier merchant. Hot paths should still
  // prefer reading the plan once and consulting capabilitiesFor()
  // directly; this helper is for one-shot checks.
  async assertCapability(storeId: string, capability: MerchantCapability) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { plan: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    if (!planHas(store.plan, capability)) {
      throw new ForbiddenException('هذه الميزة تتطلب ترقية باقة المتجر');
    }
  }

  // Public listing — anyone (even unauthenticated UI) can browse stores.
  // We never include `webhookSecret`. Filtered to publicly-visible
  // statuses only (see PUBLIC_STORE_STATUSES) so draft / submitted /
  // pending_review / changes_requested / rejected / suspended stores
  // never appear in the consumer marketplace. Merchants reach their
  // own non-public stores via listMine; admins use /admin/* which
  // bypasses this filter.
  list() {
    return this.prisma.store.findMany({
      where: { status: { in: PUBLIC_STORE_STATUSES as unknown as string[] } },
      select: PUBLIC_STORE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Stores owned by the JWT viewer. Powers the store dashboard's "pick
  // your store" header and the create-store CTA visibility.
  //
  // NOT filtered by status — the merchant must see their own pending /
  // draft / suspended stores so they can resume the onboarding flow
  // or contact support. This is the owner-private view.
  listMine(viewerUserId: string) {
    return this.prisma.store.findMany({
      where: { ownerId: viewerUserId },
      select: PUBLIC_STORE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Anonymous detail read. Same public-status gate as list(). Returns
  // 404 (not 403) when the store exists but is in a non-public state —
  // a deep-link to a suspended store should be indistinguishable from
  // a deep-link to a never-existed store; otherwise the suspension
  // itself leaks.
  async findOne(id: string) {
    const store = await this.prisma.store.findFirst({
      where: {
        id,
        status: { in: PUBLIC_STORE_STATUSES as unknown as string[] },
      },
      select: PUBLIC_STORE_SELECT,
    });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async update(viewerUserId: string, id: string, body: UpdateStoreInput) {
    await this.assertOwner(viewerUserId, id);
    const data: UpdateStoreInput = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.city === 'string') data.city = body.city.trim();
    if (typeof body.category === 'string') data.category = body.category.trim();
    return this.prisma.store.update({
      where: { id },
      data,
      select: PUBLIC_STORE_SELECT,
    });
  }

  // Returns the store if the viewer owns it; otherwise throws 403. Other
  // services (Products, Store dashboard, integrations) call this before
  // any mutation — there's no other path to ownership in the codebase
  // so the rule is in one place.
  async assertOwner(viewerUserId: string, storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      // Includes `status` so callers (patch / submit) can read the
      // current state without a second roundtrip.
      select: { id: true, ownerId: true, status: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.ownerId !== viewerUserId) {
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return store;
  }

  // Returns the list of store ids the viewer owns. Used by the store
  // dashboard to scope its order query.
  async ownedStoreIds(viewerUserId: string): Promise<string[]> {
    const rows = await this.prisma.store.findMany({
      where: { ownerId: viewerUserId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // Owner-or-admin detail view. Returns the OWNER_STORE_SELECT shape
  // (richer than the public projection) so the merchant pending-
  // approval screen + the admin review modal can render the full
  // application without an extra round-trip.
  async findOneForOwnerOrAdmin(viewerUserId: string, storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { ...OWNER_STORE_SELECT, ownerId: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    // Admin override: STORE_USER_IDS env list always passes (legacy
    // staging override, mirrors store.guard.ts).
    const allowList = (process.env.STORE_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (store.ownerId !== viewerUserId && !allowList.includes(viewerUserId)) {
      // Defer to AdminGuard upstream when this is hit from an admin
      // path; here we don't know the viewer's role so fail closed.
      throw new ForbiddenException(FORBIDDEN_MSG);
    }
    return store;
  }
}

// Sanitise a list of zone inputs from the wire. Drops entries with
// empty `city`, trims strings, and normalises the optional fields
// so a buggy client can't corrupt the JSON column. Returns the
// canonical array shape the matchAddressToZones helper expects.
function sanitizeZones(input: unknown): {
  city: string;
  districts?: string[];
  note?: string;
}[] {
  if (!Array.isArray(input)) return [];
  const out: { city: string; districts?: string[]; note?: string }[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const z = raw as Record<string, unknown>;
    const city = typeof z.city === 'string' ? z.city.trim() : '';
    if (!city) continue;
    const districts = Array.isArray(z.districts)
      ? (z.districts as unknown[])
          .map((d) => (typeof d === 'string' ? d.trim() : ''))
          .filter((d): d is string => d.length > 0)
      : undefined;
    const note = typeof z.note === 'string' ? z.note.trim() : undefined;
    out.push({
      city,
      ...(districts && districts.length > 0 ? { districts } : {}),
      ...(note ? { note } : {}),
    });
  }
  return out;
}

// Re-export so admin.service can use the same valid-status set.
export { VALID_STATUS_TRANSITIONS };
