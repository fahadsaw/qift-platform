// Lane 2 PR 3 (Scope B): LIVE database proof that constitutionally
// immutable tables reject UPDATE/DELETE while compensating INSERTs
// remain lawful. Run against the SCRATCH database after
// `prisma migrate deploy` (never production):
//   DATABASE_URL=postgresql://...qift_migration_check node scripts/verify-append-only.mjs
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL ?? '';
if (/railway|proxy\.rlwy|prod/i.test(url)) {
  console.error('append-only-verify: refusing to run against production-like URL');
  process.exit(1);
}
const prisma = new PrismaClient();
let failures = 0;
const expectReject = async (label, fn) => {
  try {
    await fn();
    console.error(`FAIL: ${label} SUCCEEDED (must be rejected)`);
    failures++;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes('append_only_violation')) {
      console.log(`ok: ${label} rejected by trigger`);
    } else {
      console.error(`FAIL: ${label} rejected for the WRONG reason: ${msg}`);
      failures++;
    }
  }
};

const run = async () => {
  // Seed one ledger row (INSERT is lawful).
  const row = await prisma.financialLedgerEntry.create({
    data: {
      eventType: 'order.paid',
      reasonCode: 'VERIFY_APPEND_ONLY',
      actorType: 'system',
      amount: 1,
      currency: 'SAR',
      direction: 'debit',
      idempotencyKey: `verify:${Math.random().toString(36).slice(2)}`,
    },
  });
  await expectReject('UPDATE FinancialLedgerEntry', () =>
    prisma.$executeRawUnsafe(
      `UPDATE "FinancialLedgerEntry" SET amount = 999 WHERE id = '${row.id}'`,
    ),
  );
  await expectReject('DELETE FinancialLedgerEntry', () =>
    prisma.$executeRawUnsafe(
      `DELETE FROM "FinancialLedgerEntry" WHERE id = '${row.id}'`,
    ),
  );
  // Compensating entry remains lawful (forward-only corrections).
  const comp = await prisma.financialLedgerEntry.create({
    data: {
      eventType: 'order.paid',
      reasonCode: 'VERIFY_APPEND_ONLY_COMPENSATION',
      actorType: 'system',
      amount: 1,
      currency: 'SAR',
      direction: 'credit',
      idempotencyKey: `verify-comp:${Math.random().toString(36).slice(2)}`,
    },
  });
  console.log(`ok: compensating INSERT lawful (${comp.id})`);
  // Audit row: protected.
  const audit = await prisma.auditLog.create({
    data: {
      actorType: 'system',
      action: 'verify.append_only',
      targetType: 'system',
      targetId: null,
    },
  });
  await expectReject('UPDATE AuditLog', () =>
    prisma.$executeRawUnsafe(
      `UPDATE "AuditLog" SET action = 'tampered' WHERE id = '${audit.id}'`,
    ),
  );
  await expectReject('DELETE AuditLog', () =>
    prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = '${audit.id}'`),
  );
  await prisma.$disconnect();
  if (failures > 0) {
    console.error(`append-only-verify: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('append-only-verify: ALL PROTECTIONS HOLD');
};
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
