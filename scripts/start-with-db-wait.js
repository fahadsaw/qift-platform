#!/usr/bin/env node
/* eslint-disable */
// scripts/start-with-db-wait.js
//
// Production startup orchestrator for Railway (and any other host that
// may start the API container before Postgres is ready).
//
// Sequence:
//   1. Parse DATABASE_URL.
//   2. TCP-probe DATABASE_URL host:port up to 120 seconds total, with
//      exponential backoff capped at a 5s interval.
//   3. Once the database accepts a TCP connection, run
//      `npx prisma migrate deploy` and wait for it to succeed.
//   4. Spawn `node dist/main` (the compiled Nest app) and forward
//      signals so the runtime can perform graceful shutdown.
//
// Why this exists:
//   Railway can start the API container before the Postgres container
//   finishes booting. Prisma migrate deploy fails with
//   P1001 "Can't reach database server" if it runs too early; Railway
//   marks the API as crashed and restarts it, causing flapping during
//   cold starts. This script blocks startup until the database accepts
//   TCP connections, then proceeds with migrations + app boot.
//
// Discipline:
//   - No external npm dependencies. Only Node built-ins (url, net,
//     child_process). This keeps the production image lean and avoids
//     dependency-version drift in a startup-critical path.
//   - Plain CommonJS .js so no TypeScript compilation is required at
//     container start.
//   - Logs are prefixed `[startup]` so they are easy to grep in
//     Railway / CloudWatch / Loki / etc.
//
// Non-goals:
//   - This script does NOT run health checks against the application
//     layer. It only verifies TCP-level reachability to Postgres.
//   - It does NOT modify DATABASE_URL, schema, or production data.

const net = require('net');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

const TIMEOUT_MS = 120_000;
const INITIAL_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[startup] ${message}`);
}

function fail(message, exitCode) {
  // eslint-disable-next-line no-console
  console.error(`[startup] ${message}`);
  process.exit(exitCode == null ? 1 : exitCode);
}

// ---------------------------------------------------------------------
// DATABASE_URL parsing
// ---------------------------------------------------------------------

function parseDatabaseUrl(raw) {
  if (!raw) {
    fail('DATABASE_URL is not set; cannot determine database host:port');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    fail(`DATABASE_URL is not a valid URL: ${err.message}`);
  }
  const host = parsed.hostname;
  if (!host) {
    fail('DATABASE_URL has no host component');
  }
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    fail(`DATABASE_URL has an invalid port: ${parsed.port}`);
  }
  return { host, port };
}

// ---------------------------------------------------------------------
// TCP probe
// ---------------------------------------------------------------------

function probeOnce(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => cleanup(true));
    socket.once('timeout', () => cleanup(false));
    socket.once('error', () => cleanup(false));
    socket.connect(port, host);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDb() {
  const { host, port } = parseDatabaseUrl(process.env.DATABASE_URL);
  log(`Waiting for database at ${host}:${port}...`);

  const deadline = Date.now() + TIMEOUT_MS;
  let interval = INITIAL_INTERVAL_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const ok = await probeOnce(host, port);
    if (ok) {
      log(`Database reachable after ${attempt} attempt(s) (${host}:${port})`);
      return;
    }
    if (Date.now() + interval >= deadline) break;
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), MAX_INTERVAL_MS);
  }

  fail(
    `Database at ${host}:${port} did not accept TCP connections within ` +
      `${Math.round(TIMEOUT_MS / 1000)}s (${attempt} attempts). Failing fast so ` +
      `the orchestrator (Railway) can restart the container.`,
  );
}

// ---------------------------------------------------------------------
// Prisma migrate
// ---------------------------------------------------------------------

function runMigrate() {
  log('Running Prisma migrations...');
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    fail(`Failed to invoke 'npx prisma migrate deploy': ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Prisma migrate deploy exited with code ${result.status}`);
  }
}

// ---------------------------------------------------------------------
// Nest app boot
// ---------------------------------------------------------------------

function startApp() {
  log('Starting Nest app...');
  const child = spawn('node', ['dist/main'], {
    stdio: 'inherit',
    env: process.env,
  });

  // Forward shutdown signals to the child so Nest can run its
  // graceful-shutdown hooks (close DB pools, drain in-flight requests).
  const forward = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGHUP', () => forward('SIGHUP'));

  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the signal so the parent exits the same way.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });

  child.on('error', (err) => {
    fail(`Failed to spawn 'node dist/main': ${err.message}`);
  });
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  await waitForDb();
  runMigrate();
  startApp();
}

main().catch((err) => {
  fail(`Unexpected startup error: ${err.stack || err.message || String(err)}`);
});
