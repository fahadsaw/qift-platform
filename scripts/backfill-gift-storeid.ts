// Backfill Gift.storeId from Product.storeId for orphaned gifts.
//
// CONTEXT
// Pre-fix-5ce322d, OrdersService.create persisted Order.storeId as
// `body.storeId?.trim() || null` with no server-side derivation
// from the catalog product. Buyers whose checkout payload was
// missing storeIdRef created Order rows with storeId=null, which
// propagated to Gift.storeId=null at payment confirm. Those gifts
// are permanently invisible on /store/orders even though
// Product.storeId knows the right merchant.
//
// This script repairs the leak: for every Gift with productId != null
// AND storeId == null, look up product.storeId and write it back.
// Same fallback rule the live code now uses on create.
//
// USAGE
//   # dry-run (default — prints what WOULD change, writes nothing)
//   pnpm --filter api ts-node scripts/backfill-gift-storeid.ts
//
//   # apply
//   pnpm --filter api ts-node scripts/backfill-gift-storeid.ts --apply
//
//   # only consider gifts created in the last N days
//   pnpm --filter api ts-node scripts/backfill-gift-storeid.ts --days 30
//
// SAFETY
// - Dry-run by default. The --apply flag is mandatory to write.
// - Only fills NULL → value. Never overwrites a non-null storeId
//   even if it disagrees with product.storeId (drift detection
//   belongs in the diagnostic script, not the backfill).
// - Logs every change for audit.
// - Cancelled / delivered gifts are skipped (terminal states; the
//   merchant can't act on them anyway, no point reviving them).
// - PRIVACY: identifiers only in logs. No message text, no
//   addresses.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const daysFlag = args.indexOf('--days');
  const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) || 0 : 0;
  const cutoff =
    days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

  console.log(
    `\nBackfill mode: ${apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}` +
      (cutoff ? ` — only gifts since ${cutoff.toISOString()}` : ''),
  );

  // Find candidates. Terminal statuses excluded — backfilling a
  // delivered or cancelled gift can't help the merchant ship
  // something that's already shipped or off the table.
  const candidates = await prisma.gift.findMany({
    where: {
      storeId: null,
      productId: { not: null },
      status: { notIn: ['delivered', 'cancelled'] },
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    },
    select: {
      id: true,
      productId: true,
      productName: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\nCandidates: ${candidates.length}\n`);
  if (candidates.length === 0) {
    console.log('Nothing to backfill. Goodbye.');
    return;
  }

  // Bulk-fetch product → storeId map so we don't N+1 the DB.
  const productIds = Array.from(
    new Set(
      candidates
        .map((c) => c.productId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  );
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, storeId: true },
  });
  const storeIdByProduct = new Map(products.map((p) => [p.id, p.storeId]));

  let updatedCount = 0;
  let skippedNoProduct = 0;
  for (const gift of candidates) {
    const newStoreId = gift.productId
      ? storeIdByProduct.get(gift.productId) ?? null
      : null;
    if (!newStoreId) {
      // Product is gone (deleted) or productId was already invalid
      // when the gift was created. Skip — there's nothing to
      // resolve to.
      skippedNoProduct += 1;
      console.log(
        `  skip ${gift.id}  product=${gift.productId} (not found)`,
      );
      continue;
    }
    console.log(
      `  fix  ${gift.id}  status=${gift.status}  product=${gift.productId}  → storeId=${newStoreId}`,
    );
    if (apply) {
      await prisma.gift.update({
        where: { id: gift.id },
        data: { storeId: newStoreId },
      });
      // Also propagate to the linked Order row, where it's also
      // null. Keeps Order.storeId / Gift.storeId in sync — useful
      // for any future query that joins on Order.storeId.
      await prisma.order.updateMany({
        where: { giftId: gift.id, storeId: null },
        data: { storeId: newStoreId },
      });
      updatedCount += 1;
    }
  }

  console.log('');
  console.log(`Total candidates : ${candidates.length}`);
  console.log(`Skipped (no prod): ${skippedNoProduct}`);
  console.log(`Updated          : ${apply ? updatedCount : 0}${apply ? '' : ' (dry-run)'}`);
  if (!apply) {
    console.log('\nRe-run with --apply to write the changes.');
  }
}

main()
  .catch((err) => {
    console.error('backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
