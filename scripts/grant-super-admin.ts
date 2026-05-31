// Grant / verify the super_admin ops-role — the only role that carries
// `user.purge` (permanent account deletion).
//
// WHY THIS SCRIPT EXISTS
// ──────────────────────
// `super_admin` is NOT a User.role value. It is a two-layer construct:
//
//   1. User.role === 'admin'         → passes the coarse AdminGuard.
//   2. OpsRoleAssignment{role:        → passes OpsRoleGuard for every
//        'super_admin'}                  @RequireOpsPermission route,
//                                        including user.purge.
//
// (See prisma/schema.prisma `model OpsRoleAssignment`, the catalog in
// src/ops-roles/ops-roles.ts, and the guard chain on
// PATCH /admin/users/:id/purge.)
//
// A fresh deployment has ZERO OpsRoleAssignment rows, so NOBODY can
// purge until someone is granted super_admin. An admin that is missing
// the ops grant gets a 403 ("Operation requires elevated permissions")
// on the purge route — which the frontend renders as the Arabic toast
// "لا تملك الصلاحية اللازمة لهذه العملية". That 403 is correct: purge is
// super_admin-only by design. This script is how you mint the first
// super_admin (and re-mint, idempotently) without hand-editing the DB.
//
// WHAT IT DOES
// ────────────
//   - Promotes the TARGET user (default @qift) to super_admin:
//       * sets User.role = 'admin' if it isn't already, and
//       * upserts OpsRoleAssignment{role:'super_admin'} (idempotent).
//   - REFUSES to elevate a soft-deleted / purged row.
//   - ASSERTS (read-only) that a guard list of accounts (default
//     @fahad) does NOT hold user.purge — so a routine promotion can
//     never silently widen who can purge. It never mutates these
//     accounts; it only warns.
//   - Optional --revoke <username> (repeatable) strips super_admin from
//     a named account — the repair path if someone was elevated by
//     mistake. Off by default; @fahad is never touched.
//
// WHAT IT NEVER DOES
// ──────────────────
//   - Never edits the permission catalog (ops-roles.ts / role-map.ts):
//     purge stays super_admin-only, trust_safety never gains it.
//   - Never touches any user other than the named target / revoke list.
//   - Never demotes the target's User.role (only ever sets it TO admin).
//   - Never deletes a User row.
//
// USAGE (run from apps/api so dotenv finds .env, or pass DATABASE_URL)
// ────────────────────────────────────────────────────────────────────
//   # audit only — prints current state + planned actions, no writes:
//   npx ts-node -P prisma/tsconfig.seed.json scripts/grant-super-admin.ts
//
//   # apply the default (promote @qift, assert @fahad lacks purge):
//   npx ts-node -P prisma/tsconfig.seed.json scripts/grant-super-admin.ts --apply
//
//   # promote a different account:
//   npx ts-node ... scripts/grant-super-admin.ts --username someadmin --apply
//
//   # repair: strip an accidental super_admin grant:
//   npx ts-node ... scripts/grant-super-admin.ts --revoke wronguser --apply
//
// Defaults are also overridable by env:
//   SUPER_ADMIN_USERNAME   (target; default "qift")
//   SUPER_ADMIN_GRANTED_BY (audit attribution; default sentinel below)
//   ASSERT_NO_PURGE        (comma-separated guard list; default "fahad")

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { permissionsFor, type OpsPermission } from '../src/ops-roles/ops-roles';

const PURGE: OpsPermission = 'user.purge';
const SUPER_ADMIN = 'super_admin';
const GRANTED_BY_SENTINEL = 'ops-script:grant-super-admin';

type Args = {
  username: string;
  revoke: string[];
  assertNoPurge: string[];
  grantedBy: string;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    username: (process.env.SUPER_ADMIN_USERNAME ?? 'qift').trim(),
    revoke: [],
    assertNoPurge: (process.env.ASSERT_NO_PURGE ?? 'fahad')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    grantedBy: (process.env.SUPER_ADMIN_GRANTED_BY ?? GRANTED_BY_SENTINEL).trim(),
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--username') out.username = (argv[++i] ?? '').trim();
    else if (a === '--revoke') out.revoke.push((argv[++i] ?? '').trim());
    else if (a === '--assert-no-purge')
      out.assertNoPurge.push((argv[++i] ?? '').trim());
    else if (a === '--granted-by') out.grantedBy = (argv[++i] ?? '').trim();
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  out.revoke = out.revoke.filter(Boolean);
  out.assertNoPurge = out.assertNoPurge.filter(Boolean);
  return out;
}

function printUsage() {
  console.log(
    [
      'Usage: grant-super-admin.ts [flags]',
      '',
      '  --username NAME       account to promote to super_admin (default: qift)',
      '  --revoke NAME         strip super_admin from NAME (repeatable; repair path)',
      '  --assert-no-purge N   account that MUST NOT hold user.purge (repeatable;',
      '                        default: fahad). Read-only assertion, never mutated.',
      '  --granted-by ID       audit attribution stored on the grant',
      '  --apply               actually write (default: dry-run / audit only)',
    ].join('\n'),
  );
}

// Resolve a user by qiftUsername (exact, then case-insensitive).
async function findUser(prisma: PrismaClient, username: string) {
  const select = {
    id: true,
    qiftUsername: true,
    role: true,
    deletedAt: true,
  } as const;
  return (
    (await prisma.user.findFirst({ where: { qiftUsername: username }, select })) ??
    (await prisma.user.findFirst({
      where: { qiftUsername: { equals: username, mode: 'insensitive' } },
      select,
    }))
  );
}

async function opsRolesOf(prisma: PrismaClient, userId: string): Promise<string[]> {
  const rows = await prisma.opsRoleAssignment.findMany({
    where: { userId },
    select: { role: true },
  });
  return rows.map((r) => r.role);
}

// The effective purge verdict mirrors the live guard chain exactly:
// AdminGuard (role === 'admin') AND OpsRoleGuard (ops perms ∋ user.purge).
function purgeVerdict(role: string, roles: string[]): boolean {
  return role === 'admin' && permissionsFor(roles).has(PURGE);
}

async function describe(prisma: PrismaClient, username: string, label: string) {
  const u = await findUser(prisma, username);
  if (!u) {
    console.log(`  ${label} @${username}: NOT FOUND`);
    return null;
  }
  const roles = await opsRolesOf(prisma, u.id);
  console.log(
    `  ${label} @${u.qiftUsername} (id=${u.id})\n` +
      `      User.role        = ${u.role}\n` +
      `      deletedAt        = ${u.deletedAt ? u.deletedAt.toISOString() : 'null (active)'}\n` +
      `      opsRoles         = [${roles.join(', ') || '—'}]\n` +
      `      effective purge  = ${purgeVerdict(u.role, roles) ? 'YES' : 'no'}`,
  );
  return { ...u, roles };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    console.log(
      `\n=== grant-super-admin (${args.apply ? 'APPLY' : 'DRY-RUN'}) ===`,
    );
    console.log(`target        : @${args.username}`);
    console.log(`revoke        : [${args.revoke.map((r) => '@' + r).join(', ') || '—'}]`);
    console.log(`assert-no-purge: [${args.assertNoPurge.map((r) => '@' + r).join(', ')}]`);

    // ── BEFORE ───────────────────────────────────────────────────
    console.log('\n--- current state ---');
    const target = await describe(prisma, args.username, 'TARGET ');
    for (const r of args.revoke) await describe(prisma, r, 'REVOKE ');
    for (const a of args.assertNoPurge) await describe(prisma, a, 'ASSERT ');

    if (!target) {
      console.error(`\nABORT: target @${args.username} not found.`);
      process.exit(1);
    }
    if (target.deletedAt) {
      console.error(
        `\nABORT: target @${args.username} is soft-deleted/purged ` +
          `(deletedAt=${target.deletedAt.toISOString()}). Refusing to elevate.`,
      );
      process.exit(1);
    }

    // ── PLAN ─────────────────────────────────────────────────────
    const needRole = target.role !== 'admin';
    const needGrant = !target.roles.includes(SUPER_ADMIN);
    console.log('\n--- planned actions ---');
    if (!needRole && !needGrant) {
      console.log(`  TARGET already super_admin — nothing to change (idempotent).`);
    } else {
      if (needRole)
        console.log(`  SET   @${target.qiftUsername} User.role: ${target.role} → admin`);
      if (needGrant)
        console.log(`  GRANT @${target.qiftUsername} OpsRoleAssignment{super_admin}`);
    }
    for (const r of args.revoke) console.log(`  REVOKE super_admin from @${r}`);

    if (!args.apply) {
      console.log('\ndry-run (no --apply) — no changes written. Re-run with --apply.\n');
      return;
    }

    // ── APPLY ────────────────────────────────────────────────────
    await prisma.$transaction(async (tx) => {
      if (needRole) {
        await tx.user.update({
          where: { id: target.id },
          data: { role: 'admin' },
        });
      }
      // Idempotent: unique (userId, role). Re-running only refreshes
      // the audit attribution, never duplicates the grant.
      await tx.opsRoleAssignment.upsert({
        where: { userId_role: { userId: target.id, role: SUPER_ADMIN } },
        create: {
          userId: target.id,
          role: SUPER_ADMIN,
          grantedBy: args.grantedBy || null,
        },
        update: { grantedBy: args.grantedBy || null, grantedAt: new Date() },
      });
    });

    for (const username of args.revoke) {
      const u = await findUser(prisma, username);
      if (!u) {
        console.log(`  (revoke) @${username} not found — skipped.`);
        continue;
      }
      await prisma.opsRoleAssignment.deleteMany({
        where: { userId: u.id, role: SUPER_ADMIN },
      });
    }

    // ── AFTER ────────────────────────────────────────────────────
    console.log('\n--- resulting state ---');
    const after = await describe(prisma, args.username, 'TARGET ');
    for (const r of args.revoke) await describe(prisma, r, 'REVOKE ');

    // ── SAFETY ASSERTION ─────────────────────────────────────────
    console.log('\n--- safety assertion (read-only) ---');
    let failed = false;
    for (const username of args.assertNoPurge) {
      const u = await findUser(prisma, username);
      if (!u) {
        console.log(`  @${username}: NOT FOUND (skipped)`);
        continue;
      }
      const roles = await opsRolesOf(prisma, u.id);
      const hasPurge = purgeVerdict(u.role, roles);
      console.log(
        `  @${username}: effective purge = ${hasPurge ? 'YES ⚠️' : 'no ✓'}`,
      );
      if (hasPurge) failed = true;
    }

    if (after && !purgeVerdict(after.role, after.roles)) {
      console.error('\nPOST-CHECK FAILED: target does not have effective purge.');
      process.exit(1);
    }
    if (failed) {
      console.error(
        '\nPOST-CHECK WARNING: an assert-no-purge account holds user.purge. ' +
          'Investigate (use --revoke to strip the grant).',
      );
      process.exit(1);
    }
    console.log('\nDone. Target is super_admin; guard list is clean.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
