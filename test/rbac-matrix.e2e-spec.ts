// RBAC matrix — end-to-end verification of the AdminGuard +
// OpsRoleGuard + StoreGuard chain across every authorization role
// shape, under BOTH RBAC_PERMISSION_CHECKS_ENABLED states. Boots a
// real Nest app, issues real HTTP requests via supertest, asserts
// expected status + exception message for every (account, endpoint)
// combination, AND asserts cross-flag equivalence on every cell.
//
// PURPOSE
// Validates that flipping RBAC_PERMISSION_CHECKS_ENABLED in any
// environment produces zero observable change in authorization
// outcomes, against real Prisma data instead of mocks. The unit-level
// equivalence in ops-roles-catalog-equivalence.spec.ts proves the two
// role→permission maps agree; this spec proves the full request
// chain (JWT extraction, guard composition, exception serialization)
// agrees too.
//
// PREREQUISITE — seed must have been run with
//   QIFT_SEED_RBAC_TEST_ACCOUNTS=true npx prisma db seed
// so the 11 rbac-test-* accounts + 8 OpsRoleAssignment rows exist,
// plus the default merchant seed for A2 (`merchant-rosary`). If any
// expected account is missing, the suite throws in beforeAll with a
// pointer to the seed command — fail loud, not silent skip.
//
// OPT-IN — not run by default. Invoke via:
//   npm run test:e2e:rbac-matrix
// (the dedicated package.json script added alongside this file).
// Picked up automatically by `npm run test:e2e` general too, since
// the .e2e-spec.ts suffix matches the e2e regex; operators wanting
// to skip the matrix in general e2e runs can exclude this filename
// via --testPathIgnorePatterns.
//
// SCOPE
//   12 accounts × 7 endpoints × 2 flag states     = 168 matrix cases
//   84 cross-flag equivalence cells                =  84 equivalence cases
//   Total: 252 cases per full run.
//
// NO PRODUCTION EFFECT
// Logs in via password against pre-seeded accounts and asserts
// authorization outcomes. The ONLY write it performs is toggling the
// `deletedAt` timestamp of the single A12 fixture row (rbac-test-A12):
// A12 is momentarily reactivated so it can obtain a REAL token, then
// soft-deleted so the matrix can verify AdminGuard rejects a valid
// token from a soft-deleted admin per-request. afterAll restores A12 to
// the exact state it was found in, so the suite is non-destructive and
// re-runnable. It never writes any other row and never touches a row
// outside the rbac-test-* prefix or merchant-rosary. This suite must
// only ever run against a seeded NON-production database (the CI
// ephemeral Postgres or a local test DB): production has no rbac-test-*
// accounts, so the beforeAll prerequisite check fails loudly there
// before any write is attempted. Runs in `--runInBand` (per
// package.json script) because the env-var mutation between tests would
// be racy with jest's parallel workers.

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// ─────────────────────────────────────────────────────────────────────
// Account table
// ─────────────────────────────────────────────────────────────────────

// Passwords match prisma/seed.ts:
//   - RBAC_TEST_PASSWORD: used by every rbac-test-* account.
//   - MERCHANT_TEST_PASSWORD: used by the existing merchant seed which
//     A2 (= merchant-rosary) belongs to.
const RBAC_TEST_PASSWORD = 'staging-rbac-test-pwd';
const MERCHANT_TEST_PASSWORD = 'qift-merchant-dev';

// A2 reuses the existing seeded merchant rather than creating a new
// Store row in the RBAC seed. The phone for login is resolved at
// runtime in beforeAll so the spec stays decoupled from the merchant
// seed's MERCHANTS array.
const A2_USER_ID = 'merchant-rosary';

type AccountId =
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'A6'
  | 'A7'
  | 'A8'
  | 'A9'
  | 'A10'
  | 'A11'
  | 'A12';

type Account = {
  id: AccountId;
  userId: string;
  // For RBAC seed accounts: hardcoded synthetic Saudi-format phone
  // from prisma/seed.ts. For A2: filled in at beforeAll from the DB.
  identifier: string;
  password: string;
  description: string;
};

const ACCOUNTS: Account[] = [
  {
    id: 'A1',
    userId: 'rbac-test-A1',
    identifier: '+966500001001',
    password: RBAC_TEST_PASSWORD,
    description: 'normal user',
  },
  {
    id: 'A2',
    userId: A2_USER_ID,
    identifier: '__resolved_in_beforeAll__',
    password: MERCHANT_TEST_PASSWORD,
    description: 'merchant / store',
  },
  {
    id: 'A3',
    userId: 'rbac-test-A3',
    identifier: '+966500001003',
    password: RBAC_TEST_PASSWORD,
    description: 'legacy admin (no ops grants)',
  },
  {
    id: 'A4',
    userId: 'rbac-test-A4',
    identifier: '+966500001004',
    password: RBAC_TEST_PASSWORD,
    description: 'admin + support',
  },
  {
    id: 'A5',
    userId: 'rbac-test-A5',
    identifier: '+966500001005',
    password: RBAC_TEST_PASSWORD,
    description: 'admin + finance',
  },
  {
    id: 'A6',
    userId: 'rbac-test-A6',
    identifier: '+966500001006',
    password: RBAC_TEST_PASSWORD,
    description: 'admin + merchant_review',
  },
  {
    id: 'A7',
    userId: 'rbac-test-A7',
    identifier: '+966500001007',
    password: RBAC_TEST_PASSWORD,
    description: 'admin + operations_manager',
  },
  {
    id: 'A8',
    userId: 'rbac-test-A8',
    identifier: '+966500001008',
    password: RBAC_TEST_PASSWORD,
    description: 'admin + trust_safety',
  },
  {
    id: 'A9',
    userId: 'rbac-test-A9',
    identifier: '+966500001009',
    password: RBAC_TEST_PASSWORD,
    description: 'admin + fulfillment_ops',
  },
  {
    id: 'A10',
    userId: 'rbac-test-A10',
    identifier: '+966500001010',
    password: RBAC_TEST_PASSWORD,
    description: 'admin + analytics_viewer',
  },
  {
    id: 'A11',
    userId: 'rbac-test-A11',
    identifier: '+966500001011',
    password: RBAC_TEST_PASSWORD,
    description: 'super_admin',
  },
  {
    id: 'A12',
    userId: 'rbac-test-A12',
    identifier: '+966500001012',
    password: RBAC_TEST_PASSWORD,
    description: 'soft-deleted admin',
  },
];

// ─────────────────────────────────────────────────────────────────────
// Endpoint table
// ─────────────────────────────────────────────────────────────────────

type EndpointKey = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7';
type EndpointSpec = {
  key: EndpointKey;
  method: 'GET';
  path: string;
  description: string;
};

// Representative coverage. The unit-level admin-rbac-coverage.spec
// already iterates every documented /admin/* GET; the e2e matrix
// picks a representative subset spanning each guard family to keep
// runtime bounded while still exercising every dispatch class.
const ENDPOINTS: ReadonlyArray<EndpointSpec> = [
  {
    key: 'E1',
    method: 'GET',
    path: '/admin/users',
    description: 'AdminGuard only (undecorated)',
  },
  {
    key: 'E2',
    method: 'GET',
    path: '/admin/stores',
    description: 'AdminGuard only (undecorated)',
  },
  {
    key: 'E3',
    method: 'GET',
    path: '/admin/system',
    description: 'AdminGuard only (undecorated)',
  },
  {
    key: 'E4',
    method: 'GET',
    path: '/admin/users/rbac-test-A3/ops-roles',
    description: '@RequireOpsPermission(user.read)',
  },
  {
    key: 'E5',
    method: 'GET',
    path: '/admin/search?q=rbac-matrix-probe',
    description: '@RequireOpsPermission(diagnostics.read)',
  },
  {
    key: 'E6',
    method: 'GET',
    path: '/admin/finance/stores',
    description: '@RequireOpsPermission(finance.read_payouts)',
  },
  {
    key: 'E7',
    method: 'GET',
    path: '/store/orders',
    description: 'StoreGuard (scope isolation)',
  },
];

// ─────────────────────────────────────────────────────────────────────
// Expected outcomes
// ─────────────────────────────────────────────────────────────────────

type Outcome = {
  status: 200 | 401 | 403;
  // Partial substring match against res.body.message. Empty/undefined
  // → don't assert on the message body (used for success cases and
  // StoreGuard's Arabic message which is not pinned).
  bodyContains?: string;
};

const OK: Outcome = { status: 200 };
const ADMIN_REJ: Outcome = {
  status: 403,
  bodyContains: 'Admin access required',
};
const OPS_REJ: Outcome = {
  status: 403,
  bodyContains: 'Operation requires elevated permissions',
};
// StoreGuard returns an Arabic exception message. We assert 403 only;
// the exact Arabic literal is intentionally not pinned here so a
// future copy edit on the StoreGuard wording doesn't break this spec.
const STORE_REJ: Outcome = { status: 403 };

const EXPECTED: Record<AccountId, Record<EndpointKey, Outcome>> = {
  // A1 — normal user (role='user'). AdminGuard rejects every /admin/*
  // route; StoreGuard rejects /store/* (no Store ownership).
  A1: {
    E1: ADMIN_REJ,
    E2: ADMIN_REJ,
    E3: ADMIN_REJ,
    E4: ADMIN_REJ,
    E5: ADMIN_REJ,
    E6: ADMIN_REJ,
    E7: STORE_REJ,
  },

  // A2 — merchant (role='store', owns store-rosary). AdminGuard
  // rejects /admin/*; /store/orders authorises.
  A2: {
    E1: ADMIN_REJ,
    E2: ADMIN_REJ,
    E3: ADMIN_REJ,
    E4: ADMIN_REJ,
    E5: ADMIN_REJ,
    E6: ADMIN_REJ,
    E7: OK,
  },

  // A3 — legacy admin, no ops grants. AdminGuard passes the
  // undecorated routes; OpsRoleGuard rejects every decorated route
  // (no ops permissions in the catalog OR legacy map).
  A3: {
    E1: OK,
    E2: OK,
    E3: OK,
    E4: OPS_REJ,
    E5: OPS_REJ,
    E6: OPS_REJ,
    E7: STORE_REJ,
  },

  // A4 — admin + support. Catalog/legacy both grant user.read +
  // diagnostics.read + store.read_detail + report.read. Missing
  // finance.read_payouts.
  A4: { E1: OK, E2: OK, E3: OK, E4: OK, E5: OK, E6: OPS_REJ, E7: STORE_REJ },

  // A5 — admin + finance. Grants finance.read_payouts /
  // record_payout_event / approve_payout + store.read_detail +
  // analytics.read. Missing user.read + diagnostics.read.
  A5: {
    E1: OK,
    E2: OK,
    E3: OK,
    E4: OPS_REJ,
    E5: OPS_REJ,
    E6: OK,
    E7: STORE_REJ,
  },

  // A6 — admin + merchant_review. Grants store.review +
  // store.read_detail + store.set_status. None of the three E4/E5/E6
  // permissions granted.
  A6: {
    E1: OK,
    E2: OK,
    E3: OK,
    E4: OPS_REJ,
    E5: OPS_REJ,
    E6: OPS_REJ,
    E7: STORE_REJ,
  },

  // A7 — admin + operations_manager. Broadest non-super_admin
  // operations role: grants user.read + diagnostics.read + others.
  // Still missing finance.read_payouts.
  A7: { E1: OK, E2: OK, E3: OK, E4: OK, E5: OK, E6: OPS_REJ, E7: STORE_REJ },

  // A8 — admin + trust_safety. Grants user.read + user.suspend +
  // report.read + report.resolve + store.set_status. Missing
  // diagnostics.read + finance.read_payouts.
  A8: {
    E1: OK,
    E2: OK,
    E3: OK,
    E4: OK,
    E5: OPS_REJ,
    E6: OPS_REJ,
    E7: STORE_REJ,
  },

  // A9 — admin + fulfillment_ops. Grants store.read_detail +
  // diagnostics.read. Missing user.read + finance.read_payouts.
  A9: {
    E1: OK,
    E2: OK,
    E3: OK,
    E4: OPS_REJ,
    E5: OK,
    E6: OPS_REJ,
    E7: STORE_REJ,
  },

  // A10 — admin + analytics_viewer. Grants only analytics.read.
  // None of the three E4/E5/E6 permissions granted.
  A10: {
    E1: OK,
    E2: OK,
    E3: OK,
    E4: OPS_REJ,
    E5: OPS_REJ,
    E6: OPS_REJ,
    E7: STORE_REJ,
  },

  // A11 — super_admin. Holds every OpsPermission via the catalog's
  // ALL_ADMIN_PERMISSIONS aggregate AND the legacy map's
  // SUPER_ADMIN_ALL — pinned by ops-roles-catalog-equivalence.spec.
  // /store/* still 403: super_admin is still role='admin', not store.
  A11: { E1: OK, E2: OK, E3: OK, E4: OK, E5: OK, E6: OK, E7: STORE_REJ },

  // A12 — soft-deleted admin. beforeAll logs A12 in WHILE ACTIVE (to
  // mint a real token), then soft-deletes it before the matrix runs.
  // AdminGuard's deletedAt rejection runs BEFORE the RBAC dispatch, so
  // every /admin/* route returns 'Admin access required' regardless of
  // catalog grants. /store/orders also 403 (admin doesn't own a Store).
  A12: {
    E1: ADMIN_REJ,
    E2: ADMIN_REJ,
    E3: ADMIN_REJ,
    E4: ADMIN_REJ,
    E5: ADMIN_REJ,
    E6: ADMIN_REJ,
    E7: STORE_REJ,
  },
};

// ─────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────

type Case = {
  accountId: AccountId;
  description: string; // composed for the test name
  endpointKey: EndpointKey;
  method: 'GET';
  path: string;
  expected: Outcome;
};

function buildCases(): Case[] {
  const out: Case[] = [];
  for (const a of ACCOUNTS) {
    for (const e of ENDPOINTS) {
      out.push({
        accountId: a.id,
        description: `${a.id} (${a.description}) ${e.method} ${e.path} [${e.description}]`,
        endpointKey: e.key,
        method: e.method,
        path: e.path,
        expected: EXPECTED[a.id][e.key],
      });
    }
  }
  return out;
}

describe('RBAC matrix (e2e, both flag states + cross-flag equivalence)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const jwts = new Map<AccountId, string>();

  // A12 is the soft-deleted-admin fixture. The matrix needs A12 to hold
  // a REAL token AND be soft-deleted, but auth login (F2) correctly
  // refuses soft-deleted users. So beforeAll reactivates A12, logs it
  // in, then soft-deletes it before the matrix; afterAll restores its
  // original state. A12's userId is fixed by the seed.
  const A12_USER_ID = 'rbac-test-A12';
  const A12_SOFT_DELETED_AT = new Date('2024-01-01T00:00:00Z');
  let a12OriginalDeletedAt: Date | null = null;

  // Save originals so the spec restores process.env on teardown — any
  // sibling e2e spec that runs after this one inherits a clean
  // environment.
  const ORIGINAL_RBAC = process.env.RBAC_PERMISSION_CHECKS_ENABLED;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // Verify every required account exists in the DB. Fail loud with
    // the seed command in the message so the operator can recover
    // without reading this file.
    for (const a of ACCOUNTS) {
      const u = await prisma.user.findUnique({ where: { id: a.userId } });
      if (!u) {
        const hint =
          a.id === 'A2'
            ? "Run the default 'npx prisma db seed' so the merchant accounts (incl. merchant-rosary) exist."
            : "Run 'QIFT_SEED_RBAC_TEST_ACCOUNTS=true npx prisma db seed' so the rbac-test-* accounts exist.";
        throw new Error(
          `RBAC matrix prerequisite missing: User '${a.userId}' ` +
            `(${a.id} — ${a.description}). ${hint}`,
        );
      }
      // For A2: pull the phone identifier from the seeded row so we
      // don't have to track the merchant seed's MERCHANTS array.
      if (a.id === 'A2') {
        if (!u.phone) {
          throw new Error(
            `RBAC matrix prerequisite invalid: merchant-rosary has no phone column populated.`,
          );
        }
        a.identifier = u.phone;
      }
      // Capture A12's seeded deletedAt so afterAll can restore it
      // exactly — the login + matrix lifecycle below toggles it.
      if (a.id === 'A12') {
        a12OriginalDeletedAt = u.deletedAt ?? null;
      }
    }

    // A12 is seeded soft-deleted; auth login (F2) refuses soft-deleted
    // users. Momentarily reactivate A12 so it can obtain a REAL token
    // in the login loop below. It is re-soft-deleted immediately after,
    // before any matrix case runs. This write is scoped to the single
    // A12 fixture row and reverted in afterAll.
    await prisma.user.update({
      where: { id: A12_USER_ID },
      data: { deletedAt: null },
    });

    // Log every account in. Captures access tokens once; reused
    // across the whole suite. Login is a single POST per account —
    // 12 requests total during setup.
    for (const a of ACCOUNTS) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ identifier: a.identifier, password: a.password });

      // POST /auth/login returns 201 Created — NestJS's default for
      // @Post() routes; the controller deliberately has no @HttpCode
      // override and 201 is the long-standing production contract the
      // frontend consumes. Accept either 2xx success shape here; the
      // REAL login-success gate is the non-empty accessToken checked
      // just below.
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `Login failed for ${a.id} (${a.userId}) at /auth/login: ` +
            `status=${res.status} body=${JSON.stringify(res.body)}. ` +
            `Identifier='${a.identifier}'. Verify the seed ran and the ` +
            `passwords in prisma/seed.ts match RBAC_TEST_PASSWORD / ` +
            `MERCHANT_TEST_PASSWORD constants in this spec.`,
        );
      }
      const token = (res.body as { accessToken?: unknown }).accessToken;
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error(
          `Login succeeded (${res.status}) but no accessToken in body for ${a.id}: ${JSON.stringify(res.body)}`,
        );
      }
      jwts.set(a.id, token);
    }

    // A12 now holds a valid JWT minted while active. Soft-delete it so
    // every matrix case exercises AdminGuard's per-request deletedAt
    // rejection with a REAL token. F2 is unaffected — a genuine
    // soft-deleted password login still 401s (proven in
    // auth.service.spec.ts); we only reactivated A12 transiently above.
    await prisma.user.update({
      where: { id: A12_USER_ID },
      data: { deletedAt: A12_SOFT_DELETED_AT },
    });
  });

  afterAll(async () => {
    if (ORIGINAL_RBAC === undefined) {
      delete process.env.RBAC_PERMISSION_CHECKS_ENABLED;
    } else {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = ORIGINAL_RBAC;
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
    // Restore the A12 fixture to the exact deletedAt we found it in, so
    // the suite is non-destructive and re-runnable against the same DB.
    // Best-effort: a restore hiccup must not crash teardown.
    if (prisma) {
      await prisma.user
        .update({
          where: { id: A12_USER_ID },
          data: { deletedAt: a12OriginalDeletedAt },
        })
        .catch(() => {});
    }
    if (app) await app.close();
  });

  async function runOnce(
    c: Case,
  ): Promise<{ status: number; message: string }> {
    const jwt = jwts.get(c.accountId);
    const res = await request(app.getHttpServer())
      .get(c.path)
      .set('Authorization', `Bearer ${jwt ?? ''}`);
    const body: unknown = res.body;
    let message = '';
    if (
      body !== null &&
      typeof body === 'object' &&
      'message' in body &&
      typeof (body as { message?: unknown }).message === 'string'
    ) {
      message = (body as { message: string }).message;
    }
    return { status: res.status, message };
  }

  // ───────────────────────────────────────────────────────────────────
  // Matrix — every (account, endpoint) pair under each flag state.
  // ───────────────────────────────────────────────────────────────────

  for (const flag of ['0', '1'] as const) {
    describe(`RBAC_PERMISSION_CHECKS_ENABLED=${flag}`, () => {
      beforeEach(() => {
        process.env.RBAC_PERMISSION_CHECKS_ENABLED = flag;
      });

      const cases = buildCases();
      it.each(cases)('$description', async (c) => {
        const res = await runOnce(c);
        expect(res.status).toBe(c.expected.status);
        if (c.expected.bodyContains) {
          expect(res.message).toContain(c.expected.bodyContains);
        }
      });
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Cross-flag equivalence — the load-bearing assertion at the
  // request-chain level. The 136-case ops-roles-catalog-equivalence
  // spec proves the maps agree; this proves the full HTTP path does.
  // ───────────────────────────────────────────────────────────────────

  describe('cross-flag equivalence (every cell produces identical outcome)', () => {
    const cases = buildCases();
    it.each(cases)('$description — flag OFF ≡ flag ON', async (c) => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      const off = await runOnce(c);
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      const on = await runOnce(c);
      expect(on.status).toBe(off.status);
      // Compare exception message on rejection. Skip for 200 (success
      // body shape varies per endpoint and is not in scope here).
      if (off.status !== 200) {
        expect(on.message).toBe(off.message);
      }
    });
  });
});
