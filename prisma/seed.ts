// Local-dev seed script. Populates Follow, Gift, Wish, and the test
// merchant accounts (Store-role users + their Stores + Products) so
// the public profile UI, the merchant fulfilment dashboard, and the
// admin /admin/stores tab all render realistic data out of the box.
//
// Idempotent end-to-end:
//   - Follow rows are upserted on the composite PK (followerId, followingId).
//   - Gift and Wish rows use deterministic seed IDs ("seed-gift-<i>-<slot>",
//     "seed-wish-<i>-<slot>") and upsert by id. Re-running never duplicates.
//   - Merchant users / Stores / Products use stable string IDs derived
//     from the demo-store slug ("merchant-rosary", "store-rosary",
//     "store-rosary-p1"). Upsert-by-id keeps them deterministic.
//   - Empty `update: {}` on every upsert means existing rows are not mutated
//     by re-seeding — original timestamps and isAnonymous flags survive.
//
// PRIVATE-TESTING ONLY: this script is meant for the dev / staging
// database and should NOT be run against production. The merchant
// accounts use predictable phones and a shared password so the
// private-testing flow is easy to reproduce. See PRIVATE_TESTING.md
// for the credentials and the full sender → recipient → merchant
// walkthrough.

import { Prisma, PrismaClient } from '@prisma/client';
import { generateReference } from '../src/references/reference';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Shared password for every seeded merchant account. Documented in
// PRIVATE_TESTING.md. Changing this string requires re-seeding (the
// hash is regenerated on every run).
const MERCHANT_TEST_PASSWORD = 'qift-merchant-dev';
const BCRYPT_ROUNDS = 10;

// Realistic-feeling fixtures, rotated through with a counter so sample
// data doesn't all read identical.
const PRODUCTS: ReadonlyArray<{ product: string; store: string }> = [
  { product: 'باقة ورود جوري', store: 'روزاري' },
  { product: 'كيك بستاشيو', store: 'سويتس بوتيك' },
  { product: 'عطر الرحلة', store: 'ميسون عطر' },
  { product: 'صندوق شوكولاتة', store: 'كاكاو' },
  { product: 'بطاقة هدية', store: 'متجر الإهداء' },
  { product: 'كتاب الفنجان', store: 'مكتبة جرير' },
  { product: 'شمعة عطرية', store: 'هوم سنترال' },
];

const WISHES: ReadonlyArray<{ title: string; store: string | null }> = [
  { title: 'عطر الرحلة', store: 'ميسون عطر' },
  { title: 'باقة بيوني وردي', store: 'روزاري' },
  { title: 'كتاب: الرحلة', store: null },
  { title: 'ساعة كلاسيكية', store: 'بريسون' },
  { title: 'سماعات بلوتوث', store: 'متجر تك' },
  { title: 'حقيبة ظهر', store: null },
  { title: 'إكسسوار جلدي', store: 'كرافت ستوديو' },
];

// Merchant fixtures. Each entry produces: one User (role='store'),
// one Store (status='approved'), and several Products. The slug
// matches the frontend's STORES[i].id so the demo /stores grid maps
// cleanly to the seeded backend rows. Phones live in the +966500000xxx
// reserved-test block to avoid colliding with real registrations.
//
// Onboarding-v2 fixtures additionally carry deliveryZones so the
// recipient-side coverage check can be tested end-to-end against
// addresses inside vs. outside the merchant's service area.
type MerchantFixture = {
  slug: string;
  storeName: string;
  ownerUsername: string;
  ownerFullName: string;
  ownerPhone: string;
  city: string;
  category: string;
  products: Array<{ slug: string; name: string; price: number }>;
  // Optional — only the v2 fixtures carry these.
  legalEntityName?: string;
  countryOfRegistration?: string;
  commercialRegistrationNumber?: string;
  contactPerson?: string;
  contactPhone?: string;
  contactEmail?: string;
  deliveryZones?: Array<{ city: string; districts?: string[] }>;
};

const MERCHANTS: ReadonlyArray<MerchantFixture> = [
  {
    slug: 'rosary',
    storeName: 'روزاري',
    ownerUsername: 'merchant.rosary',
    ownerFullName: 'متجر روزاري',
    ownerPhone: '+966500000101',
    city: 'الرياض',
    category: 'flowers',
    products: [
      { slug: 'p1', name: 'باقة جوري بلدي', price: 220 },
      { slug: 'p2', name: 'صندوق جوري كبير', price: 450 },
      { slug: 'p3', name: 'باقة بيوني وردي', price: 320 },
    ],
  },
  {
    slug: 'cocoa',
    storeName: 'كوكوا هاوس',
    ownerUsername: 'merchant.cocoa',
    ownerFullName: 'متجر كوكوا هاوس',
    ownerPhone: '+966500000102',
    city: 'الرياض',
    category: 'chocolate',
    products: [
      { slug: 'p1', name: 'علبة بلجيكية ١٢ قطعة', price: 175 },
      { slug: 'p2', name: 'علبة فاخرة ٢٤ قطعة', price: 320 },
    ],
  },
  {
    slug: 'patisserie',
    storeName: 'باتسري نوارا',
    ownerUsername: 'merchant.patisserie',
    ownerFullName: 'متجر باتسري نوارا',
    ownerPhone: '+966500000103',
    city: 'جدة',
    category: 'cake',
    products: [
      { slug: 'p1', name: 'كيك بستاشيو', price: 280 },
      { slug: 'p2', name: 'تشيز كيك بالتوت', price: 240 },
    ],
  },
  {
    slug: 'maison',
    storeName: 'ميسون عطر',
    ownerUsername: 'merchant.maison',
    ownerFullName: 'متجر ميسون عطر',
    ownerPhone: '+966500000104',
    city: 'الرياض',
    category: 'perfume',
    products: [
      { slug: 'p1', name: 'عطر الرحلة', price: 620 },
      { slug: 'p2', name: 'عطر مساء', price: 740 },
    ],
  },
  {
    slug: 'gifted',
    storeName: 'هدايا مختارة',
    ownerUsername: 'merchant.gifted',
    ownerFullName: 'متجر هدايا مختارة',
    ownerPhone: '+966500000105',
    city: 'الدمام',
    category: 'gifts',
    products: [
      { slug: 'p1', name: 'صندوق صباح', price: 190 },
      { slug: 'p2', name: 'صندوق الهدوء', price: 245 },
    ],
  },
  {
    slug: 'rosa-jeddah',
    storeName: 'روزا جدة',
    ownerUsername: 'merchant.rosajeddah',
    ownerFullName: 'متجر روزا جدة',
    ownerPhone: '+966500000106',
    city: 'جدة',
    category: 'flowers',
    products: [
      { slug: 'p1', name: 'باقة الربيع', price: 260 },
      { slug: 'p2', name: 'صندوق توليب', price: 320 },
    ],
  },
  // ── Onboarding-v2 verification fixtures ─────────────────────
  // Two merchants that exercise the new business onboarding path:
  // one narrow-coverage Saudi merchant (Riyadh districts only) and
  // one GCC-wide perfume merchant. Both have a fully-populated
  // application + delivery zones so the recipient-side coverage
  // check has a real workload to test against.
  //
  // CREDENTIALS for testing:
  //   Riyadh-only merchant
  //     phone:    +966500000201
  //     username: merchant.riyadh.flowers
  //     password: qift-merchant-dev   (shared, see top of file)
  //
  //   GCC-wide perfume merchant
  //     phone:    +966500000202
  //     username: merchant.gcc.perfumes
  //     password: qift-merchant-dev
  {
    slug: 'riyadh-flowers',
    storeName: 'باقات الرياض',
    ownerUsername: 'merchant.riyadh.flowers',
    ownerFullName: 'باقات الرياض',
    ownerPhone: '+966500000201',
    city: 'الرياض',
    category: 'flowers',
    legalEntityName: 'باقات الرياض للتجارة',
    countryOfRegistration: 'SA',
    commercialRegistrationNumber: '1010123456',
    contactPerson: 'مدير العمليات',
    contactPhone: '+966500000201',
    contactEmail: 'ops@riyadh-flowers.test',
    // Narrow Riyadh-only coverage with district whitelist. A
    // recipient with a Wadi Al-Dawasir address (also in منطقة
    // الرياض administratively but ~600km away) is correctly
    // blocked. Inside Riyadh, only these northern + central
    // districts are covered for same-day flowers.
    deliveryZones: [
      {
        city: 'الرياض',
        districts: [
          'العليا',
          'الملقا',
          'الياسمين',
          'النرجس',
          'الصحافة',
          'الفلاح',
          'حطين',
          'الورود',
          'الواحة',
        ],
      },
    ],
    products: [
      { slug: 'p1', name: 'باقة جوري الرياض', price: 250 },
      { slug: 'p2', name: 'باقة تيوليب فاخر', price: 380 },
      { slug: 'p3', name: 'صندوق ورد كلاسيكي', price: 290 },
      { slug: 'p4', name: 'باقة بيوني وردي', price: 340 },
      { slug: 'p5', name: 'تنسيق ورد للمكاتب', price: 420 },
    ],
  },
  {
    slug: 'gcc-perfumes',
    storeName: 'House of Oud',
    ownerUsername: 'merchant.gcc.perfumes',
    ownerFullName: 'House of Oud',
    ownerPhone: '+966500000202',
    city: 'الرياض',
    category: 'perfume',
    legalEntityName: 'House of Oud Trading',
    countryOfRegistration: 'AE',
    commercialRegistrationNumber: 'DED-789456',
    contactPerson: 'Customer Care',
    contactPhone: '+971500000202',
    contactEmail: 'care@houseofoud.test',
    // GCC-wide coverage. Lists the major capital + secondary
    // commercial cities across all six countries. No district
    // whitelist — perfume isn't time-sensitive so coverage is
    // city-level. Lets the eligibility check pass for a
    // recipient address in any of these cities.
    deliveryZones: [
      // Saudi Arabia
      { city: 'الرياض' },
      { city: 'جدة' },
      { city: 'الدمام' },
      { city: 'الخبر' },
      { city: 'مكة المكرمة' },
      { city: 'المدينة المنورة' },
      // Kuwait
      { city: 'مدينة الكويت' },
      { city: 'السالمية' },
      { city: 'الفروانية' },
      // UAE
      { city: 'دبي' },
      { city: 'أبوظبي' },
      { city: 'الشارقة' },
      // Qatar
      { city: 'الدوحة' },
      // Bahrain
      { city: 'المنامة' },
      { city: 'الرفاع' },
      // Oman
      { city: 'مسقط' },
      { city: 'صلالة' },
    ],
    products: [
      { slug: 'p1', name: 'عطر العود الملكي', price: 850 },
      { slug: 'p2', name: 'عطر زيت العود الفاخر', price: 1450 },
      { slug: 'p3', name: 'مجموعة العود الذهبية', price: 2200 },
      { slug: 'p4', name: 'بخور المسك الأبيض', price: 320 },
      { slug: 'p5', name: 'عطر الياسمين الدمشقي', price: 690 },
      { slug: 'p6', name: 'مجموعة هدية فاخرة', price: 3500 },
    ],
  },
];

// Idempotent merchant seeder. Creates User (role='store') + Store
// (status='approved') + Products for every fixture above. Re-runs
// are safe — every entity uses a stable id derived from the slug.
//
// Returns a map slug → storeId so the gifts seeder below can back-
// link existing seeded gifts to the correct store row when the
// product names match.
async function seedMerchants(): Promise<Map<string, string>> {
  console.log(`Seeding merchants: ${MERCHANTS.length} stores.`);
  const passwordHash = await bcrypt.hash(MERCHANT_TEST_PASSWORD, BCRYPT_ROUNDS);
  const slugToStoreId = new Map<string, string>();

  for (const m of MERCHANTS) {
    const userId = `merchant-${m.slug}`;
    const storeId = `store-${m.slug}`;

    // 1) Owner user — role='store', phoneVerifiedAt stamped so the
    // login flow doesn't ask for an OTP for these test accounts.
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        qiftUsername: m.ownerUsername,
        fullName: m.ownerFullName,
        phone: m.ownerPhone,
        passwordHash,
        role: 'store',
        phoneVerifiedAt: new Date(),
      },
      update: {
        // Re-seed keeps the existing username/fullName but re-syncs
        // the password hash + role so an operator who tweaked the
        // shared password can rotate everyone in one re-seed pass.
        passwordHash,
        role: 'store',
      },
    });

    // 2) Store row, owned by the user above. status='approved' so
    // these stores show up in /admin/stores AND in the merchant
    // fulfilment queue immediately — no admin click required for
    // the private-testing flow to work.
    //
    // Onboarding-v2 fixtures additionally write the business /
    // legal / coverage fields. The non-v2 fixtures (rosary, cocoa,
    // etc.) leave these null; the schema default keeps them off.
    const v2Extras = {
      legalEntityName: m.legalEntityName ?? null,
      countryOfRegistration: m.countryOfRegistration ?? null,
      commercialRegistrationNumber: m.commercialRegistrationNumber ?? null,
      contactPerson: m.contactPerson ?? null,
      contactPhone: m.contactPhone ?? null,
      contactEmail: m.contactEmail?.toLowerCase() ?? null,
      // JSONB column. Prisma needs Prisma.DbNull (not raw JS null)
      // to write SQL NULL on a nullable JSON column. Empty /
      // undefined → DbNull, matching the matchAddressToZones
      // contract documented in lib/deliveryZones.ts.
      deliveryZones:
        m.deliveryZones && m.deliveryZones.length > 0
          ? (m.deliveryZones as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
    };
    await prisma.store.upsert({
      where: { id: storeId },
      create: {
        id: storeId,
        name: m.storeName,
        ownerId: userId,
        city: m.city,
        category: m.category,
        status: 'approved',
        integrationType: 'none',
        integrationStatus: 'disconnected',
        ...v2Extras,
      },
      update: {
        // Existing seeded stores inherit any operator-driven status
        // change (e.g. an admin manually flipped one to 'suspended'
        // for testing) — we don't clobber that on re-seed. We DO
        // refresh the human-readable fields in case they drifted.
        name: m.storeName,
        city: m.city,
        category: m.category,
        // Re-syncing v2 fields on every seed lets us tweak coverage
        // zones in this file and have them land without a manual
        // PATCH. Existing fields not present on the fixture row
        // don't get clobbered (they stay at whatever the operator
        // edited).
        ...v2Extras,
      },
    });
    slugToStoreId.set(m.slug, storeId);

    // 3) Products. Stable ids of the form "store-<slug>-<productSlug>"
    // so the catalog stays diff-friendly across re-seeds.
    for (const p of m.products) {
      const productId = `${storeId}-${p.slug}`;
      await prisma.product.upsert({
        where: { id: productId },
        create: {
          id: productId,
          storeId,
          name: p.name,
          price: p.price,
          category: m.category,
          sourceType: 'manual',
          stockStatus: 'in_stock',
          isAvailable: true,
        },
        update: {
          name: p.name,
          price: p.price,
          category: m.category,
        },
      });
    }
  }

  console.log(
    `  → ${MERCHANTS.length} merchant accounts ready. Login: phone + password "${MERCHANT_TEST_PASSWORD}".`,
  );
  return slugToStoreId;
}

// ─────────────────────────────────────────────────────────────────────
// RBAC test accounts — staging only.
//
// PURPOSE
// Provisions 11 deterministic accounts spanning every authorization
// role shape so test/rbac-matrix.e2e-spec (added in a follow-up PR)
// can exercise OpsRoleGuard's dual-path dispatch under both
// RBAC_PERMISSION_CHECKS_ENABLED states with real Prisma data.
//
// The 12th matrix shape — merchant/store — REUSES the existing
// seeded merchant `merchant-rosary` rather than creating a new
// Store row. This keeps the RBAC seed scope narrow (no Store
// fixtures, no per-store coverage/zones) and avoids entangling
// the RBAC seed with the merchant-onboarding seed shapes.
//
// SAFETY (defense in depth — either gate alone refuses a run)
//   1. Primary gate: QIFT_SEED_RBAC_TEST_ACCOUNTS must equal 'true'.
//      Production environments MUST NEVER have this var set. The
//      gate var is intentionally absent from the production
//      Railway service Variables tab and from .env / .env.example.
//   2. Defense gate: DATABASE_URL is best-effort string-checked for
//      production-ish substrings. If the URL appears to reference a
//      production database the function THROWS — not skips — so a
//      misconfigured staging deploy fails loud during `prisma db
//      seed` rather than silently writing test rows into prod.
//
// DETERMINISTIC IDS
// Every seeded user has id matching /^rbac-test-A\d{1,2}$/. Cleanup
// is therefore the two-statement DELETE shown in the closing log.
// The id prefix is visually unmistakable in any database GUI.
//
// IDEMPOTENT
// Upsert with empty `update: {}` mirrors the existing merchant seed
// pattern: re-running the seed never mutates already-created rows.
// Operators can safely re-seed without losing manual edits.
//
// NO SCHEMA CHANGE
// Every column written (id, qiftUsername, phone, email, passwordHash,
// role, phoneVerifiedAt, deletedAt on User; userId, role, grantedBy
// on OpsRoleAssignment) already exists on the deployed schema. No
// Prisma migration. The deletedAt field on A12 stamps the row as
// soft-deleted for the AdminGuard regression-check case.

const RBAC_TEST_PASSWORD = 'staging-rbac-test-pwd';

// Saudi mobile prefix (+9665…) with a clearly synthetic suffix
// (00000100X) so collisions with real phone numbers are impossible.
// Emails use the RFC 6761 reserved '.invalid' TLD so the addresses
// can never resolve in real DNS and Resend's domain-restriction
// (configured separately on the staging Resend key) provides a
// second layer of recipient safety.
const RBAC_TEST_ACCOUNTS: ReadonlyArray<{
  id: string;
  username: string;
  phone: string;
  email: string;
  role: 'user' | 'admin';
  opsRoles: ReadonlyArray<string>;
  deletedAt: Date | null;
}> = [
  // A1 — normal user. Baseline: should 403 on every /admin/* route.
  {
    id: 'rbac-test-A1',
    username: 'rbac_test_normal',
    phone: '+966500001001',
    email: 'rbac-test-a1@qift-rbac-test.invalid',
    role: 'user',
    opsRoles: [],
    deletedAt: null,
  },
  // A2 (merchant/store) is intentionally NOT created here — the
  // matrix maps A2 to the existing seeded merchant `merchant-rosary`.

  // A3 — legacy admin with no ops grants. Passes coarse AdminGuard;
  // fails every @RequireOpsPermission route.
  {
    id: 'rbac-test-A3',
    username: 'rbac_test_legacy_admin',
    phone: '+966500001003',
    email: 'rbac-test-a3@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: [],
    deletedAt: null,
  },
  // A4 — admin + support. Grants user.read + diagnostics.read +
  // store.read_detail + report.read.
  {
    id: 'rbac-test-A4',
    username: 'rbac_test_admin_support',
    phone: '+966500001004',
    email: 'rbac-test-a4@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['support'],
    deletedAt: null,
  },
  // A5 — admin + finance. Grants finance.read_payouts /
  // record_payout_event / approve_payout + store.read_detail +
  // analytics.read.
  {
    id: 'rbac-test-A5',
    username: 'rbac_test_admin_finance',
    phone: '+966500001005',
    email: 'rbac-test-a5@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['finance'],
    deletedAt: null,
  },
  // A6 — admin + merchant_review.
  {
    id: 'rbac-test-A6',
    username: 'rbac_test_admin_mr',
    phone: '+966500001006',
    email: 'rbac-test-a6@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['merchant_review'],
    deletedAt: null,
  },
  // A7 — admin + operations_manager.
  {
    id: 'rbac-test-A7',
    username: 'rbac_test_admin_om',
    phone: '+966500001007',
    email: 'rbac-test-a7@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['operations_manager'],
    deletedAt: null,
  },
  // A8 — admin + trust_safety.
  {
    id: 'rbac-test-A8',
    username: 'rbac_test_admin_ts',
    phone: '+966500001008',
    email: 'rbac-test-a8@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['trust_safety'],
    deletedAt: null,
  },
  // A9 — admin + fulfillment_ops.
  {
    id: 'rbac-test-A9',
    username: 'rbac_test_admin_fo',
    phone: '+966500001009',
    email: 'rbac-test-a9@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['fulfillment_ops'],
    deletedAt: null,
  },
  // A10 — admin + analytics_viewer.
  {
    id: 'rbac-test-A10',
    username: 'rbac_test_admin_av',
    phone: '+966500001010',
    email: 'rbac-test-a10@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['analytics_viewer'],
    deletedAt: null,
  },
  // A11 — super_admin. Catalog grants ALL_ADMIN_PERMISSIONS;
  // legacy map grants SUPER_ADMIN_ALL (every OpsPermission).
  // Pinned by ops-roles-catalog-equivalence.spec.ts.
  {
    id: 'rbac-test-A11',
    username: 'rbac_test_super_admin',
    phone: '+966500001011',
    email: 'rbac-test-a11@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: ['super_admin'],
    deletedAt: null,
  },
  // A12 — soft-deleted admin. Pre-stamped deletedAt so the matrix
  // verifies AdminGuard rejects with 'Admin access required' BEFORE
  // any RBAC dispatch happens. If AuthService.login refuses to
  // issue a JWT for soft-deleted accounts, the matrix spec will
  // need to set deletedAt post-login via SQL — that's a spec-side
  // concern; this seed always stamps deletedAt up front.
  {
    id: 'rbac-test-A12',
    username: 'rbac_test_admin_deleted',
    phone: '+966500001012',
    email: 'rbac-test-a12@qift-rbac-test.invalid',
    role: 'admin',
    opsRoles: [],
    deletedAt: new Date('2024-01-01T00:00:00Z'),
  },
];

async function seedRbacTestAccounts(): Promise<void> {
  // PRIMARY GATE.
  if (process.env.QIFT_SEED_RBAC_TEST_ACCOUNTS !== 'true') {
    console.log('[rbac-seed] skipped (QIFT_SEED_RBAC_TEST_ACCOUNTS not set).');
    return;
  }

  // DEFENSE-IN-DEPTH GATE.
  // Refuses to run if DATABASE_URL looks production-ish. Belt +
  // braces — operational discipline (never set the gate var in prod)
  // is the real guarantee, but this catches the most obvious
  // misconfiguration: operator sets the gate var on a service whose
  // DATABASE_URL still points at production.
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (/qift-prod|prod-postgres|production/i.test(dbUrl)) {
    throw new Error(
      'Refusing to seed RBAC test accounts: DATABASE_URL appears to ' +
        'reference a production database. The seed gate ' +
        '(QIFT_SEED_RBAC_TEST_ACCOUNTS=true) must NEVER be set on a ' +
        'service that talks to production data. If the database name ' +
        "contains 'prod' / 'production' / 'qift-prod' coincidentally " +
        'and this really is a staging environment, rename the database ' +
        'to remove the substring before retrying.',
    );
  }

  console.log(
    `[rbac-seed] creating ${RBAC_TEST_ACCOUNTS.length} RBAC test ` +
      'accounts (QIFT_SEED_RBAC_TEST_ACCOUNTS=true)…',
  );

  const passwordHash = await bcrypt.hash(RBAC_TEST_PASSWORD, BCRYPT_ROUNDS);

  for (const a of RBAC_TEST_ACCOUNTS) {
    await prisma.user.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        qiftUsername: a.username,
        phone: a.phone,
        email: a.email,
        passwordHash,
        role: a.role,
        // Stamp phoneVerifiedAt so login skips OTP for these test
        // accounts — mirrors the merchant seed pattern. The matrix
        // spec then logs in with phone + password directly.
        phoneVerifiedAt: new Date(),
        deletedAt: a.deletedAt,
      },
      // Empty update: re-running the seed never mutates already-
      // created rows. Same idempotency pattern as the merchant seed
      // (which uses an empty `update: {}` on every upsert).
      update: {},
    });

    for (const opsRole of a.opsRoles) {
      await prisma.opsRoleAssignment.upsert({
        where: { userId_role: { userId: a.id, role: opsRole } },
        create: {
          userId: a.id,
          role: opsRole,
          // Legacy admin (A3) is the granter — gives the audit-log
          // chain a coherent grantedBy reference even in staging.
          grantedBy: 'rbac-test-A3',
        },
        update: {},
      });
    }
  }

  console.log(
    `[rbac-seed] ${RBAC_TEST_ACCOUNTS.length} accounts ready. ` +
      'A2 (merchant role) reuses existing seeded merchant ' +
      '`merchant-rosary` — not created here. Login: phone + password ' +
      `"${RBAC_TEST_PASSWORD}". Cleanup SQL:\n` +
      `  DELETE FROM "OpsRoleAssignment" WHERE "userId" LIKE 'rbac-test-%';\n` +
      `  DELETE FROM "User" WHERE id LIKE 'rbac-test-%';`,
  );
}

async function main() {
  // Merchants come first so the demo /stores grid + admin /admin/stores
  // tab are populated even if there are no human users yet. The social
  // ring below filters merchants out so they don't pollute the
  // follows/gifts pattern.
  const slugToStoreId = await seedMerchants();

  const users = await prisma.user.findMany({
    where: { deletedAt: null, role: { not: 'store' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, qiftUsername: true },
  });

  // RBAC staging seed — placed BEFORE the early-return check below so
  // it runs on a fresh DB where `users.length < 2` would otherwise
  // skip the rest of main(). The findMany above has already bound
  // `users`, so RBAC admins (which this call may create) do NOT fold
  // into the social-ring section's follows / gifts / wishes
  // generation even when that section does run.
  //
  // No-op unless QIFT_SEED_RBAC_TEST_ACCOUNTS=true.
  await seedRbacTestAccounts();

  if (users.length < 2) {
    console.log(
      `Found ${users.length} non-merchant user(s) — need at least 2 to seed follows/gifts. Skipping the rest.`,
    );
    return;
  }

  const N = users.length;
  const now = new Date();

  // ---------- Follows ----------
  // Cyclic ring: each user follows the next K users (mod N), giving
  // every user exactly K follows-out and K follows-in. K=4 with the
  // current 7-user dev DB.
  const K = Math.min(4, N - 1);
  console.log(`Seeding follows: N=${N} users, K=${K} edges per direction.`);
  for (let i = 0; i < N; i++) {
    for (let j = 1; j <= K; j++) {
      const followerId = users[i].id;
      const followingId = users[(i + j) % N].id;
      await prisma.follow.upsert({
        where: {
          followerId_followingId: { followerId, followingId },
        },
        create: {
          followerId,
          followingId,
          status: 'accepted',
          acceptedAt: now,
        },
        update: {},
      });
    }
  }

  // ---------- Gifts ----------
  // Cyclic pattern, slot ∈ {1, 2}: user[i] sends gifts to user[i+1] and
  // user[i+2]. From the receiver's side this means user[j] receives gifts
  // from user[j-1] and user[j-2]. Net result: each user has exactly
  // 2 sent + 2 received gifts. Slot ≥ 1 guarantees senderId ≠ receiverId.
  console.log('Seeding gifts: each user sends 2 + receives 2 (cyclic).');
  // Past base date so the gifts have plausible delivery timestamps.
  const baseDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  let giftCounter = 0;
  for (let i = 0; i < N; i++) {
    for (let slot = 1; slot <= 2; slot++) {
      const senderId = users[i].id;
      const receiverId = users[(i + slot) % N].id;
      const id = `seed-gift-${i}-${slot}`;
      const product = PRODUCTS[giftCounter % PRODUCTS.length];
      // Deterministic anonymity pattern (~33%) — keeps re-seeds stable
      // and gives the UI both flag states to render.
      const isAnonymous = giftCounter % 3 === 0;
      const createdAt = new Date(
        baseDate.getTime() + giftCounter * 24 * 60 * 60 * 1000,
      );
      const confirmedAt = new Date(
        createdAt.getTime() + 1 * 24 * 60 * 60 * 1000,
      );
      const shippedAt = new Date(createdAt.getTime() + 3 * 24 * 60 * 60 * 1000);
      const deliveredAt = new Date(
        createdAt.getTime() + 5 * 24 * 60 * 60 * 1000,
      );

      // Best-effort back-link to a real Store row by exact name. Demo
      // gifts whose store doesn't have a seeded merchant counterpart
      // stay storeId=null (they still render correctly — the merchant
      // dashboard simply ignores them, which matches the legacy
      // sample-product flow). The merchant for `روزاري` and the
      // others get real linked rows so the merchant fulfilment queue
      // has data on first run.
      const matchedMerchant = MERCHANTS.find(
        (m) => m.storeName === product.store,
      );
      const linkedStoreId = matchedMerchant
        ? (slugToStoreId.get(matchedMerchant.slug) ?? null)
        : null;

      await prisma.gift.upsert({
        where: { id },
        create: {
          id,
          // Seed-only: canonical QF reference (unique per run; the
          // upsert keys on id so re-seeding never re-creates).
          fulfillmentNumber: generateReference('QF'),
          senderId,
          receiverId,
          productName: product.product,
          storeName: product.store,
          storeId: linkedStoreId,
          status: 'delivered',
          isAnonymous,
          createdAt,
          confirmedAt,
          shippedAt,
          deliveredAt,
        },
        // Re-seed brings new gifts up to date with any merchant
        // back-link we resolved above. We leave the historical
        // status/timestamps untouched — only the FK is filled in
        // when it was previously null.
        update: linkedStoreId ? { storeId: linkedStoreId } : {},
      });
      giftCounter++;
    }
  }

  // ---------- Wishes ----------
  // Two public wishes per user. Titles rotate through the WISHES array
  // (offset by user index) so different users see different items.
  console.log('Seeding wishes: 2 public wishes per user.');
  for (let i = 0; i < N; i++) {
    for (let slot = 0; slot < 2; slot++) {
      const wishIdx = (i * 2 + slot) % WISHES.length;
      const id = `seed-wish-${i}-${slot}`;
      const wish = WISHES[wishIdx];

      await prisma.wish.upsert({
        where: { id },
        create: {
          id,
          userId: users[i].id,
          title: wish.title,
          store: wish.store,
          visibility: 'public',
        },
        update: {},
      });
    }
  }

  // ---------- Verification log ----------
  const totalFollows = await prisma.follow.count();
  const totalGifts = await prisma.gift.count();
  const totalWishes = await prisma.wish.count();
  console.log(
    `\nDone. ${totalFollows} follows, ${totalGifts} gifts, ${totalWishes} wishes.`,
  );
  console.log('\nPer-user breakdown:');
  console.log(
    '  username             followers / following / sent / received / wishes',
  );
  for (const u of users) {
    const followers = await prisma.follow.count({
      where: { followingId: u.id, status: 'accepted' },
    });
    const following = await prisma.follow.count({
      where: { followerId: u.id, status: 'accepted' },
    });
    const sent = await prisma.gift.count({
      where: { senderId: u.id, status: { not: 'cancelled' } },
    });
    const received = await prisma.gift.count({
      where: { receiverId: u.id, status: { not: 'cancelled' } },
    });
    const wishes = await prisma.wish.count({
      where: { userId: u.id, visibility: 'public' },
    });
    console.log(
      `  @${u.qiftUsername.padEnd(20)} ${String(followers).padStart(2)}        / ${String(following).padStart(2)}        / ${String(sent).padStart(2)}   / ${String(received).padStart(2)}       / ${String(wishes).padStart(2)}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
