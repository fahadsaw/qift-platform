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
// Two modes:
//
//   1. SURGICAL — pass --phone / --email / --username (each repeatable).
//      Targets exactly the rows you name. Safe for one-off ops fixes.
//
//   2. BULK     — pass --all-test-users. Targets every row with
//      role='user' (regular accounts) and DROPS rows with role='store'
//      (merchants) and role='admin' (Qift staff) from the selection.
//      Built for the production-auth reset before private testing.
//
// Both modes:
//   - Dry-run by default. No `--apply` ⇒ prints what would be deleted.
//   - Soft-delete first (sets `deletedAt` + prefixes the unique fields
//     with `__deleted_<id>_…`) so historic Gift / Order / Notification
//     / Follow rows that hold the user's id as a foreign key keep
//     resolving — you don't end up with broken joins on the merchant
//     dashboard or the admin tabs. The new register flow's
//     `where: { phone, deletedAt: null }` lookup means the soft-
//     deleted row no longer collides with a fresh signup.
//   - --hard switches to a cascade delete. Requires the schema's
//     onDelete rules to handle every relation; some (Gift.senderId on
//     non-anonymous rows) may not, so prefer soft-delete unless you
//     have a specific reason.
//   - --wipe-otp also clears every row in the Otp table. The Otp
//     table has no FK protection — codes are ephemeral 5-min tokens
//     — so this is always safe and is automatically implied by
//     --all-test-users so a re-signup can't replay a stale code.
//
// Usage
// ─────
//   # surgical, dry-run
//   npx ts-node apps/api/scripts/cleanup-test-users.ts \
//     --phone +966501234567 --email tester@example.com
//
//   # surgical, apply
//   npx ts-node apps/api/scripts/cleanup-test-users.ts \
//     --phone +966501234567 --apply
//
//   # bulk reset of every non-merchant non-admin user, dry-run
//   npx ts-node apps/api/scripts/cleanup-test-users.ts --all-test-users
//
//   # bulk reset, apply, also explicitly preserve a couple of IDs
//   # (e.g. your personal account, an early admin you haven't yet
//   # promoted via role='admin')
//   npx ts-node apps/api/scripts/cleanup-test-users.ts \
//     --all-test-users --apply \
//     --keep-id user-abc123 --keep-id user-def456
//
//   # bulk reset, also wipe Otp table explicitly
//   npx ts-node apps/api/scripts/cleanup-test-users.ts \
//     --all-test-users --apply --wipe-otp
//
// Multi-target: --phone / --email / --username / --keep-id may each
// be repeated. Phones are normalised through the same helper the API
// uses, so `0501234567` and `+966 50 123 4567` both resolve to the
// same row.

import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/auth/phone-normalize';

type Args = {
  phones: string[];
  emails: string[];
  usernames: string[];
  keepIds: string[];
  apply: boolean;
  hard: boolean;
  allTestUsers: boolean;
  wipeOtp: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    phones: [],
    emails: [],
    usernames: [],
    keepIds: [],
    apply: false,
    hard: false,
    allTestUsers: false,
    wipeOtp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--hard') out.hard = true;
    else if (a === '--all-test-users') out.allTestUsers = true;
    else if (a === '--wipe-otp') out.wipeOtp = true;
    else if (a === '--phone') out.phones.push(argv[++i] ?? '');
    else if (a === '--email') out.emails.push(argv[++i] ?? '');
    else if (a === '--username') out.usernames.push(argv[++i] ?? '');
    else if (a === '--keep-id') out.keepIds.push(argv[++i] ?? '');
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
      'Usage: cleanup-test-users.ts [mode] [flags]',
      '',
      'Surgical mode — at least one of:',
      '  --phone X     repeatable; normalised to E.164 before lookup',
      '  --email Y     repeatable; lower-cased before lookup',
      '  --username Z  repeatable; lower-cased before lookup',
      '',
      'Bulk mode:',
      "  --all-test-users   target every user with role='user'",
      '                     (excludes role=store merchants + role=admin staff)',
      '  --keep-id ID       repeatable; preserve specific user ids',
      '',
      'Common flags:',
      '  --apply       actually run the delete (default: dry-run)',
      '  --hard        hard-delete (cascade) instead of soft-delete',
      '  --wipe-otp    also truncate the Otp table',
      '                (implied by --all-test-users)',
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
  const keepIds = args.keepIds.map((s) => s.trim()).filter(Boolean);

  const surgicalCount = phones.length + emails.length + usernames.length;
  if (!args.allTestUsers && surgicalCount === 0) {
    console.error(
      'no targets supplied (need --all-test-users OR at least one --phone/--email/--username)',
    );
    printUsage();
    process.exit(2);
  }
  if (args.allTestUsers && surgicalCount > 0) {
    console.error(
      '--all-test-users is exclusive with --phone/--email/--username (it bulk-targets by role)',
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    // ── Build the match set ──────────────────────────────────────
    const matches = args.allTestUsers
      ? await prisma.user.findMany({
          where: {
            // Bulk reset rule:
            //   - role='user' only (default role on register).
            //   - role='store' merchants (seeded + future signups) are SAFE.
            //   - role='admin' Qift staff are SAFE.
            //   - already-soft-deleted rows are skipped (idempotent rerun).
            //   - keep-list ids are skipped.
            role: 'user',
            deletedAt: null,
            ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
          },
          select: {
            id: true,
            qiftUsername: true,
            phone: true,
            email: true,
            role: true,
            deletedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        })
      : await prisma.user.findMany({
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
            role: true,
            deletedAt: true,
            createdAt: true,
          },
        });

    // ── Always show what we're about to do ───────────────────────
    if (args.allTestUsers) {
      const [storeUsers, adminUsers] = await Promise.all([
        prisma.user.count({ where: { role: 'store', deletedAt: null } }),
        prisma.user.count({ where: { role: 'admin', deletedAt: null } }),
      ]);
      console.log(
        `Bulk mode: role='user' selection.\n` +
          `  Preserved by role: ${storeUsers} merchant(s) + ${adminUsers} admin(s) — UNTOUCHED.\n` +
          `  Preserved by --keep-id: ${keepIds.length} explicit id(s).\n`,
      );
    }

    if (matches.length === 0) {
      console.log('no users matched — nothing to do');
      // Still allow --wipe-otp on its own.
      if (args.wipeOtp || args.allTestUsers) {
        await wipeOtp(prisma, args.apply);
      }
      return;
    }

    console.log(`matched ${matches.length} user(s):`);
    for (const u of matches) {
      console.log(
        `  - ${u.id}  role=${u.role}  username=@${u.qiftUsername}  phone=${u.phone ?? '-'}  email=${u.email ?? '-'}  deletedAt=${u.deletedAt?.toISOString() ?? 'live'}`,
      );
    }

    if (!args.apply) {
      console.log('\ndry-run (no --apply) — exiting without changes.');
      // Show what wipe-otp would do too.
      if (args.wipeOtp || args.allTestUsers) {
        const otpCount = await prisma.otp.count();
        console.log(`would also clear ${otpCount} Otp row(s).`);
      }
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
      // Soft delete: set deletedAt + rename the unique fields so a
      // fresh re-signup with the same phone / email / username doesn't
      // collide. We KEEP the row so historic Gift / Order /
      // Notification / Follow rows that hold the user's id as a
      // foreign key continue to resolve cleanly — those joins are
      // what powers the merchant dashboard's order history and the
      // admin /admin/users audit list, and breaking them would leave
      // the UI rendering "unknown user" for past activity.
      const now = new Date();
      const result = await prisma.user.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: now },
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

    // ── OTP cleanup ─────────────────────────────────────────────
    if (args.wipeOtp || args.allTestUsers) {
      // Bulk: nuke the whole Otp table — codes are ephemeral 5-min
      // tokens with no FKs, so wholesale deletion is safe. This
      // guarantees no stale-code replay against the freshly-cleaned
      // accounts.
      await wipeOtp(prisma, args.apply);
    } else {
      // Surgical: only clear codes targeting the cleaned phones / emails.
      if (phones.length + emails.length > 0) {
        const otpDel = await prisma.otp.deleteMany({
          where: { target: { in: [...phones, ...emails] } },
        });
        if (otpDel.count > 0) {
          console.log(`also cleared ${otpDel.count} pending Otp row(s).`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function wipeOtp(prisma: PrismaClient, apply: boolean) {
  const count = await prisma.otp.count();
  if (count === 0) {
    console.log('Otp table already empty.');
    return;
  }
  if (!apply) {
    console.log(`would also clear ${count} Otp row(s).`);
    return;
  }
  const result = await prisma.otp.deleteMany({});
  console.log(`cleared ${result.count} Otp row(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
