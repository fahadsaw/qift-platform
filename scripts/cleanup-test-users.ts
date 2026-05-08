// Cleanup script for ghost / test-only user rows.
//
// Why this exists
// ───────────────
// During the dev period when OTP_DEV_MODE was wired, the register flow
// would auto-verify against the hardcoded "1234" code. Real testers
// created accounts on production with their real phones / emails
// without proving ownership. Those accounts now squat on the unique
// indexes (phone / email / username) and block legitimate re-signup
// when the same person comes back through the now-real OTP flow.
//
// This script gives ops a SAFE way to remove those ghost rows without
// going near a SQL prompt:
//
//   - Dry-run by default. No `--apply` ⇒ prints what would be deleted.
//   - Targets are explicit: phone(s), email(s), or qift username(s)
//     supplied on the command line. Never bulk-matches.
//   - Soft-delete first (sets `deletedAt`), not hard delete. Preserves
//     referential integrity for any historic Gift/Order rows that
//     might link to the user. The new register flow's
//     `where: { phone, deletedAt: null }` lookup means the soft-
//     deleted row no longer collides with a fresh signup.
//
// Usage
// ─────
//   # dry-run, see what would change
//   npx ts-node apps/api/scripts/cleanup-test-users.ts \
//     --phone +966501234567 \
//     --email tester@example.com \
//     --username tester1
//
//   # apply for real
//   npx ts-node apps/api/scripts/cleanup-test-users.ts \
//     --phone +966501234567 --apply
//
//   # cascade-hard-delete instead of soft-delete (use with extreme care
//   # — drops the user row and lets onDelete: Cascade clean child rows)
//   npx ts-node apps/api/scripts/cleanup-test-users.ts \
//     --phone +966501234567 --apply --hard
//
// Multi-target: --phone / --email / --username may each be repeated.
// Phones are normalised through the same helper the API uses, so
// `0501234567` and `+966 50 123 4567` both resolve to the same row.

import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/auth/phone-normalize';

type Args = {
  phones: string[];
  emails: string[];
  usernames: string[];
  apply: boolean;
  hard: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    phones: [],
    emails: [],
    usernames: [],
    apply: false,
    hard: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--hard') out.hard = true;
    else if (a === '--phone') out.phones.push(argv[++i] ?? '');
    else if (a === '--email') out.emails.push(argv[++i] ?? '');
    else if (a === '--username') out.usernames.push(argv[++i] ?? '');
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  console.log(
    [
      'Usage: cleanup-test-users.ts [--phone X] [--email Y] [--username Z] [--apply] [--hard]',
      '  --phone     repeatable; normalised to E.164 before lookup',
      '  --email     repeatable; lower-cased before lookup',
      '  --username  repeatable; lower-cased before lookup',
      '  --apply     actually run the delete (default: dry-run)',
      '  --hard      hard-delete (cascade) instead of soft-delete',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const phones = args.phones
    .map((p) => normalizePhone(p))
    .filter((p): p is string => !!p);
  const emails = args.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  const usernames = args.usernames
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);

  if (phones.length + emails.length + usernames.length === 0) {
    console.error(
      'no targets supplied (need at least one --phone/--email/--username)',
    );
    printUsage();
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const matches = await prisma.user.findMany({
      where: {
        OR: [
          ...(phones.length > 0 ? [{ phone: { in: phones } }] : []),
          ...(emails.length > 0 ? [{ email: { in: emails } }] : []),
          ...(usernames.length > 0
            ? [{ qiftUsername: { in: usernames } }]
            : []),
        ],
      },
      select: {
        id: true,
        qiftUsername: true,
        phone: true,
        email: true,
        deletedAt: true,
        createdAt: true,
      },
    });

    if (matches.length === 0) {
      console.log('no users matched — nothing to do');
      return;
    }

    console.log(`matched ${matches.length} user(s):`);
    for (const u of matches) {
      console.log(
        `  - ${u.id}  username=@${u.qiftUsername}  phone=${u.phone ?? '-'}  email=${u.email ?? '-'}  deletedAt=${u.deletedAt?.toISOString() ?? 'live'}`,
      );
    }

    if (!args.apply) {
      console.log('\ndry-run (no --apply) — exiting without changes.');
      return;
    }

    const ids = matches.map((u) => u.id);

    if (args.hard) {
      // Hard delete relies on Prisma's `onDelete: Cascade` for child
      // tables. Some relations are SetNull (e.g. Gift.senderId on
      // anonymous gifts) which is also fine. Anything that errors
      // out here means a relation lacks a cascade rule and needs a
      // schema migration before this branch can run.
      const result = await prisma.user.deleteMany({
        where: { id: { in: ids } },
      });
      console.log(`\nhard-deleted ${result.count} user(s).`);
    } else {
      // Soft delete: set deletedAt + null out the unique fields so a
      // fresh re-signup with the same phone / email / username doesn't
      // collide. The legacy values are kept in audit trail terms by
      // moving them into the *_deleted_at suffix is overkill for an
      // ops cleanup — instead we simply blank them and stamp deletedAt
      // so the user row remains as a tombstone for historic Gift/Order
      // foreign keys.
      const now = new Date();
      const result = await prisma.user.updateMany({
        where: { id: { in: ids } },
        data: {
          deletedAt: now,
          // Free the unique-index slots so the same person can re-sign
          // up cleanly. Suffix with the user id to keep the pre-delete
          // value discoverable in the row for audit grep without
          // breaking the unique constraint.
        },
      });
      // Per-row update for the unique fields — updateMany can't reach
      // into per-row ids for the suffix.
      for (const u of matches) {
        // qiftUsername + phone are NOT NULL on the schema, so we
        // always rewrite them with a `__deleted_<id>_…` prefix to
        // free the unique index. email is nullable, so we either
        // prefix or null it.
        await prisma.user.update({
          where: { id: u.id },
          data: {
            qiftUsername: `__deleted_${u.id}_${u.qiftUsername}`.slice(0, 191),
            phone: `__deleted_${u.id}_${u.phone}`.slice(0, 191),
            email: u.email
              ? `__deleted_${u.id}_${u.email}`.slice(0, 191)
              : null,
          },
        });
      }
      console.log(
        `\nsoft-deleted ${result.count} user(s) at ${now.toISOString()}.`,
      );
    }

    // Best-effort: also clear any pending Otp rows targeting the
    // recovered phones / emails so a stale code can't be replayed.
    if (phones.length + emails.length > 0) {
      const otpDel = await prisma.otp.deleteMany({
        where: { target: { in: [...phones, ...emails] } },
      });
      if (otpDel.count > 0) {
        console.log(`also cleared ${otpDel.count} pending Otp row(s).`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
