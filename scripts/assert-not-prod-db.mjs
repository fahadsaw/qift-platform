// Guard (Track A3 / PE-02): refuses to run destructive Prisma commands
// against anything that looks like the production database. Wired into
// the db:* package scripts; the sanctioned production migration path is
// the deploy pipeline (scripts/start-with-db-wait.js on Railway), never
// a laptop shell.
import { readFileSync, existsSync } from 'node:fs';

let url = process.env.DATABASE_URL ?? '';
if (!url && existsSync('.env')) {
  const m = readFileSync('.env', 'utf8').match(/^DATABASE_URL=(.+)$/m);
  url = m?.[1]?.trim() ?? '';
}

const PROD_PATTERNS = [/rlwy\.net/i, /railway/i, /proxy\./i, /prod/i];
if (PROD_PATTERNS.some((p) => p.test(url))) {
  console.error(
    '\n⛔ BLOCKED: DATABASE_URL looks like PRODUCTION.\n' +
      '   Destructive Prisma commands (migrate dev/reset, db push, seed)\n' +
      '   must never run against production from a laptop. Point\n' +
      '   DATABASE_URL at your local database (see docker-compose.yml).\n',
  );
  process.exit(1);
}
console.log('db-guard: DATABASE_URL is not production — proceeding.');
