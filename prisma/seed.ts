// Local-dev seed script. Populates Follow, Gift, and Wish so the public
// profile UI (/u/[username] + the followers/following modal) renders
// realistic data without manual SQL.
//
// Idempotent end-to-end:
//   - Follow rows are upserted on the composite PK (followerId, followingId).
//   - Gift and Wish rows use deterministic seed IDs ("seed-gift-<i>-<slot>",
//     "seed-wish-<i>-<slot>") and upsert by id. Re-running never duplicates.
//   - Empty `update: {}` on every upsert means existing rows are not mutated
//     by re-seeding — original timestamps and isAnonymous flags survive.
//
// Strategy for each entity is a cyclic pattern over the live-user list so
// every user gets the same shape regardless of count.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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

async function main() {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, qiftUsername: true },
  });

  if (users.length < 2) {
    console.log(
      `Found ${users.length} live user(s) — need at least 2 to seed. Skipping.`,
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

      await prisma.gift.upsert({
        where: { id },
        create: {
          id,
          senderId,
          receiverId,
          productName: product.product,
          storeName: product.store,
          status: 'delivered',
          isAnonymous,
          createdAt,
          confirmedAt,
          shippedAt,
          deliveredAt,
        },
        update: {},
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
