# Backup & Restore Runbook — Qift Production Database

**Track A9 / PE-03.** A backup that has never been restored is a hope,
not a backup. This runbook records a REAL drill against production
(2026-07-04) and the exact procedure to repeat it.

## Drill results (2026-07-04, production data)

| Step | Command | Measured |
|---|---|---|
| Dump production | `pg_dump -Fc --no-owner --no-privileges` | **20 s**, 217 KB |
| Restore to scratch DB | `createdb` + `pg_restore --no-owner --no-privileges` | **0.5 s** |
| Schema verification | `prisma migrate status` vs restored DB | ✅ "Database schema is up to date!" (all 48 repo migrations applied) |
| Data verification | Row counts restored vs live prod | ✅ identical (30 users, 11 orders; financial tables 0 rows as expected pre-settlement) |
| Migration-history integrity | Every `_prisma_migrations` row exists in the repo | ✅ 50 rows = 48 applied + 2 benign rolled-back first attempts (`audit_log`, `financial_ledger_entry`) later re-applied |

## RPO / RTO — stated honestly

- **RPO (how much data can we lose):** equals the backup cadence.
  - Railway's managed Postgres **daily backups** ⇒ RPO ≤ 24 h.
  - At pilot scale a 24 h RPO is a real risk during campaign weeks
    (claims + addresses arrive in bursts). **Mitigation:** run the
    manual dump (below, ~20 s) immediately **before every dispatch
    wave and before every migration deploy.**
- **RTO (how long to be back up):** dump restores in **under a
  minute** at current size; the dominant cost is human response +
  re-pointing `DATABASE_URL`. Realistic end-to-end: **≤ 1 hour**
  (detect → provision fresh Postgres on Railway → `pg_restore` →
  update `DATABASE_URL` → redeploy → smoke-check `/health` + login).
- These numbers hold while the DB is small. Re-run the drill (5 min)
  quarterly or when row counts grow 10×; update this table.

## Founder checklist (one-time, ~5 minutes)

1. Railway → Postgres service → **Backups**: confirm automated daily
   backups are ON and note retention. If the plan doesn't include
   them, enable, or schedule the manual dump below via cron/launchd.
2. Confirm someone other than the founder's laptop can reach the
   backups (Railway console access from a second device).

## Manual backup (run before every dispatch wave / migration)

```bash
# From apps/api. Uses the PG18 client (prod is PostgreSQL 18.x) —
# an older pg_dump will refuse. brew install postgresql@18 if needed.
PGBIN=/opt/homebrew/opt/postgresql@18/bin
PROD_URL=$(grep '^DATABASE_URL=' .env.prod.DANGER | cut -d= -f2- | tr -d '"')
$PGBIN/pg_dump --no-owner --no-privileges -Fc \
  -f ~/qift-backups/qift-prod-$(date +%Y%m%d-%H%M).dump "$PROD_URL"
```

- Read-only against prod; ~20 s at current size.
- `.env.prod.DANGER` is the gitignored quarantine file (Track A3) —
  the ONLY sanctioned place the production URL exists locally.
- Keep `~/qift-backups/` out of any synced/public folder; dumps
  contain user PII (phones, addresses).

## Restore drill / real restore

```bash
PGBIN=/opt/homebrew/opt/postgresql@18/bin
# Drill: local scratch DB. Real incident: point at the NEW hosted DB.
$PGBIN/dropdb --if-exists qift_restore_drill
$PGBIN/createdb qift_restore_drill
$PGBIN/pg_restore --no-owner --no-privileges \
  -d qift_restore_drill ~/qift-backups/<dump-file>

# Verify — BOTH must pass before trusting the restore:
DATABASE_URL=postgresql://$USER@localhost:5432/qift_restore_drill \
  pnpm exec prisma migrate status        # expect "up to date"
psql -d qift_restore_drill -c 'SELECT count(*) FROM "User"'  # sanity
```

Real-incident tail: set the restored DB's URL as `DATABASE_URL` on
Railway, redeploy, then smoke-check `GET /health`, one login, and one
admin list endpoint before announcing recovery.

## What this runbook does NOT cover (deliberately)

- Point-in-time recovery / WAL archiving — overkill pre-settlement;
  revisit at the Settlement phase gate (financial writes make RPO
  minutes-not-hours territory).
- Cross-region replicas — Expansion-phase concern.
