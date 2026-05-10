// Production-grade merchant order lineage diagnostic.
//
// PURPOSE
// Read-only CLI that inspects either the latest gift or a specific
// gift id and prints the full chain Order → Gift → Product →
// Store → owner, along with a "would /store/orders return this?"
// verdict. Use to debug "merchant doesn't see this order" reports
// without needing to write SQL or open Prisma Studio.
//
// USAGE
//   pnpm --filter api ts-node scripts/diagnose-merchant-pipeline.ts
//   pnpm --filter api ts-node scripts/diagnose-merchant-pipeline.ts <giftId>
//   pnpm --filter api ts-node scripts/diagnose-merchant-pipeline.ts --merchant <username>
//
// The merchant flag adds the question "does this user own a store
// that the gift links to?" to the verdict — answers the
// auth-mismatch failure mode (logged into wrong account).
//
// SAFETY
// READ-ONLY. Makes no writes to the DB. Safe to run against
// production with DATABASE_URL pointed at the live cluster.
//
// PRIVACY
// Output omits message text, media URLs, recipient addresses, and
// senders' names by design — only identifiers + status fields.
// Safe to paste into a support thread.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const merchantFlag = args.indexOf('--merchant');
  const merchantUsername =
    merchantFlag >= 0 ? (args[merchantFlag + 1] ?? '').trim().toLowerCase() : '';
  const positional = args.filter(
    (a, i) => !a.startsWith('--') && (i === 0 || args[i - 1] !== '--merchant'),
  );
  const giftIdArg = positional[0];

  // Resolve the target gift. Either explicit id from CLI or the
  // most-recent row.
  let giftId: string;
  if (giftIdArg) {
    giftId = giftIdArg;
  } else {
    const latest = await prisma.gift.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!latest) {
      console.error('No gifts exist in this database.');
      process.exit(1);
    }
    giftId = latest.id;
  }

  const gift = await prisma.gift.findUnique({
    where: { id: giftId },
    select: {
      id: true,
      productId: true,
      storeId: true,
      productName: true,
      storeName: true,
      status: true,
      isAnonymous: true,
      isSurprise: true,
      addressId: true,
      createdAt: true,
      confirmedAt: true,
      shippedAt: true,
      deliveredAt: true,
    },
  });
  if (!gift) {
    console.error(`Gift not found: ${giftId}`);
    process.exit(1);
  }

  const order = await prisma.order.findFirst({
    where: { giftId: gift.id },
    select: {
      id: true,
      productId: true,
      storeId: true,
      productName: true,
      storeName: true,
      status: true,
      createdAt: true,
    },
  });

  const product = gift.productId
    ? await prisma.product.findUnique({
        where: { id: gift.productId },
        select: {
          id: true,
          storeId: true,
          name: true,
          isAvailable: true,
          stockStatus: true,
        },
      })
    : null;

  const giftStore = gift.storeId
    ? await prisma.store.findUnique({
        where: { id: gift.storeId },
        select: {
          id: true,
          name: true,
          ownerId: true,
          status: true,
          owner: { select: { id: true, qiftUsername: true } },
        },
      })
    : null;

  const productStore =
    product?.storeId && product.storeId !== gift.storeId
      ? await prisma.store.findUnique({
          where: { id: product.storeId },
          select: {
            id: true,
            name: true,
            ownerId: true,
            status: true,
            owner: { select: { id: true, qiftUsername: true } },
          },
        })
      : null;

  const merchant = merchantUsername
    ? await prisma.user.findFirst({
        where: { qiftUsername: merchantUsername, deletedAt: null },
        select: { id: true, qiftUsername: true, role: true },
      })
    : null;

  const merchantOwnedStoreIds = merchant
    ? (
        await prisma.store.findMany({
          where: { ownerId: merchant.id },
          select: { id: true },
        })
      ).map((s) => s.id)
    : null;

  // /store/orders verdict — same WHERE clause as
  // StoreService.listOrders.
  const DASHBOARD_STATUSES = [
    'pending_address',
    'address_confirmed',
    'default_address_used',
    'preparing',
    'shipped',
  ];

  let verdict: { ok: boolean; reason: string; explain: string };
  if (!gift.storeId) {
    verdict = {
      ok: false,
      reason: 'gift_storeId_null',
      explain:
        'Gift.storeId is null. /store/orders filters by storeId; the row is invisible to every merchant. Run scripts/backfill-gift-storeid.ts --apply if Product.storeId is known.',
    };
  } else if (!giftStore) {
    verdict = {
      ok: false,
      reason: 'gift_store_not_found',
      explain:
        'Gift.storeId is set but no Store row exists for it. Hard-deleted store or tampered id.',
    };
  } else if (!DASHBOARD_STATUSES.includes(gift.status)) {
    verdict = {
      ok: false,
      reason: 'status_excluded',
      explain: `Gift.status="${gift.status}" is not in DASHBOARD_STATUSES (${DASHBOARD_STATUSES.join(', ')}).`,
    };
  } else if (merchant && merchantOwnedStoreIds) {
    const owns = merchantOwnedStoreIds.includes(gift.storeId);
    verdict = owns
      ? {
          ok: true,
          reason: 'ok',
          explain: `Merchant @${merchant.qiftUsername} owns store ${giftStore.name} — they SEE this gift on /store/orders.`,
        }
      : {
          ok: false,
          reason: 'merchant_does_not_own_store',
          explain: `Merchant @${merchant.qiftUsername} does NOT own store ${giftStore.name} (owner: @${giftStore.owner?.qiftUsername ?? giftStore.ownerId}). Wrong account logged in.`,
        };
  } else {
    verdict = {
      ok: true,
      reason: 'ok',
      explain: `Owner @${giftStore.owner?.qiftUsername ?? giftStore.ownerId} sees this gift when logged in.`,
    };
  }

  // Pretty-print.
  console.log('\n=== GIFT LINEAGE DIAGNOSTIC ===\n');
  console.log('Gift:');
  console.log(`  id           ${gift.id}`);
  console.log(`  productId    ${gift.productId ?? '(null)'}`);
  console.log(`  storeId      ${gift.storeId ?? '(null)'}`);
  console.log(`  productName  ${gift.productName}`);
  console.log(`  storeName    ${gift.storeName}`);
  console.log(`  status       ${gift.status}`);
  console.log(`  addressId    ${gift.addressId ?? '(null)'}`);
  console.log(`  isAnonymous  ${gift.isAnonymous}`);
  console.log(`  isSurprise   ${gift.isSurprise}`);
  console.log(`  createdAt    ${gift.createdAt.toISOString()}`);
  if (gift.confirmedAt) console.log(`  confirmedAt  ${gift.confirmedAt.toISOString()}`);
  if (gift.shippedAt) console.log(`  shippedAt    ${gift.shippedAt.toISOString()}`);
  if (gift.deliveredAt) console.log(`  deliveredAt  ${gift.deliveredAt.toISOString()}`);

  console.log('\nOrder:');
  if (order) {
    console.log(`  id           ${order.id}`);
    console.log(`  productId    ${order.productId ?? '(null)'}`);
    console.log(`  storeId      ${order.storeId ?? '(null)'}`);
    console.log(`  status       ${order.status}`);
    console.log(`  createdAt    ${order.createdAt.toISOString()}`);
    console.log(
      `  drift        gift.storeId ${order.storeId === gift.storeId ? 'matches' : '!=='} order.storeId`,
    );
  } else {
    console.log('  (no Order linked — direct POST /gifts path)');
  }

  console.log('\nProduct:');
  if (product) {
    console.log(`  id           ${product.id}`);
    console.log(`  storeId      ${product.storeId}`);
    console.log(`  name         ${product.name}`);
    console.log(`  isAvailable  ${product.isAvailable}`);
    console.log(`  stockStatus  ${product.stockStatus}`);
    if (gift.storeId && product.storeId !== gift.storeId) {
      console.log(
        `  ⚠️  drift     product.storeId (${product.storeId}) does NOT match gift.storeId (${gift.storeId})`,
      );
    }
  } else {
    console.log('  (no productId on gift — sample-product flow OR data drift)');
  }

  console.log('\nGift store (the link the dashboard query uses):');
  if (giftStore) {
    console.log(`  id           ${giftStore.id}`);
    console.log(`  name         ${giftStore.name}`);
    console.log(`  ownerId      ${giftStore.ownerId}`);
    console.log(`  ownerUser    @${giftStore.owner?.qiftUsername ?? '(unknown)'}`);
    console.log(`  status       ${giftStore.status}`);
  } else {
    console.log('  (no store linked from gift)');
  }

  if (productStore) {
    console.log('\nProduct store (different from gift store — drift indicator):');
    console.log(`  id           ${productStore.id}`);
    console.log(`  name         ${productStore.name}`);
    console.log(`  ownerId      ${productStore.ownerId}`);
    console.log(`  ownerUser    @${productStore.owner?.qiftUsername ?? '(unknown)'}`);
  }

  if (merchant) {
    console.log('\nMerchant being checked:');
    console.log(`  userId       ${merchant.id}`);
    console.log(`  username     @${merchant.qiftUsername}`);
    console.log(`  role         ${merchant.role}`);
    console.log(`  ownsStores   ${merchantOwnedStoreIds?.length ?? 0}`);
  }

  console.log('\n=== VERDICT ===');
  console.log(`  visible      ${verdict.ok ? 'YES' : 'NO'}`);
  console.log(`  reason       ${verdict.reason}`);
  console.log(`  explain      ${verdict.explain}`);
  console.log('');
}

main()
  .catch((err) => {
    console.error('diagnose failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
