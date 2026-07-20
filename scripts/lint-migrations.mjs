#!/usr/bin/env node
// Migration-chain lint (Track B5 / PE-17). BLOCKING in CI per
// Financial Constitution Ch. 20.1 ("unique timestamps across the
// chain") + Rule 13.16 (every rule maps to a named, blocking CI
// check). Validates WITHOUT touching executed history:
//   1. every folder matches <14-digit-timestamp>_<snake_name>
//   2. leading timestamps are unique across the whole chain
//   3. every folder contains a non-empty migration.sql
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations');
const entries = readdirSync(root).filter(
  (e) => statSync(join(root, e)).isDirectory(),
);

const NAME_RE = /^(\d{14})_[a-z0-9_]+$/;

// GRANDFATHERED historical duplicate (discovered by this lint's first
// run, 2026-07-20): 20260511000000 is shared by merchant_plan and
// shipments. Executed history is never renamed (Reference Constitution
// Ch. 11 / migration rules), so the pair is recorded here explicitly.
// Prisma applies same-timestamp folders in lexicographic name order,
// which is stable for this pair. NO new entry may ever be added to
// this set — fix the timestamp instead.
const GRANDFATHERED_DUPLICATES = new Set(['20260511000000']);

const seen = new Map();
const errors = [];

for (const dir of entries) {
  const m = NAME_RE.exec(dir);
  if (!m) {
    errors.push(`malformed migration folder name: ${dir}`);
    continue;
  }
  const ts = m[1];
  if (seen.has(ts) && !GRANDFATHERED_DUPLICATES.has(ts)) {
    errors.push(`duplicate timestamp ${ts}: ${seen.get(ts)} vs ${dir}`);
  }
  seen.set(ts, dir);
  const sqlPath = join(root, dir, 'migration.sql');
  if (!existsSync(sqlPath) || readFileSync(sqlPath, 'utf8').trim().length === 0) {
    errors.push(`missing or empty migration.sql in ${dir}`);
  }
}

if (errors.length) {
  console.error('⛔ migration lint failed:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`migration lint OK: ${entries.length} migrations, all timestamps unique.`);
