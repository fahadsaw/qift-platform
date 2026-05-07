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

import { PrismaClient } from '@prisma/client';
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
type MerchantFixture = {
  slug: string;
  storeName: string;
  ownerUsername: string;
  ownerFullName: string;
  ownerPhone: string;
  city: string;
  category: string;
  products: Array<{ slug: string; name: string; price: number }>;
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
      },
      update: {
        // Existing seeded stores inherit any operator-driven status
        // change (e.g. an admin manually flipped one to 'suspended'
        // for testing) — we don't clobber that on re-seed. We DO
        // refresh the human-readable fields in case they drifted.
        name: m.storeName,
        city: m.city,
        category: m.category,
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
        ? slugToStoreId.get(matchedMerchant.slug) ?? null
        : null;

      await prisma.gift.upsert({
        where: { id },
        create: {
          id,
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
