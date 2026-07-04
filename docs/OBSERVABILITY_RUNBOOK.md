# Observability Runbook — Qift API

**Track A8 / PE-08.** What ships in code, what the founder must
activate, and how to verify each piece. Before this, the only way to
learn production was broken was a user (or the founder) noticing.

## What is already live in code (no action needed)

| Piece | Where | Behavior |
|---|---|---|
| `helmet` security headers | `src/main.ts` | Always on. Safe defaults for a JSON-only API. |
| Sentry error capture | `src/instrument.ts`, `src/app.module.ts` | **NO-OP until `SENTRY_DSN` is set.** When active: unexpected 5xx errors are reported with stack traces; HTTP 4xx behavior is completely unchanged. `sendDefaultPii` is hardcoded off — phones, addresses, and OTP codes never leave the platform. |
| Health endpoint | `GET /health` | Already existed; returns 200 when the process is up. This is the uptime-monitor target. |

## Founder activation steps

### 1. Sentry (~10 minutes)

1. Create an account / org at sentry.io (free tier is fine for pilot).
2. Create a project: platform **Node.js**, name `qift-api`.
3. Copy the **DSN** (looks like `https://<key>@o<org>.ingest.sentry.io/<project>`).
4. Railway → qift-platform service → Variables → add:
   - `SENTRY_DSN` = the DSN
   - `SENTRY_ENVIRONMENT` = `production`
   - (leave `SENTRY_TRACES_SAMPLE_RATE` unset — error capture only)
5. Redeploy. Boot log must still show the `qift-api/cors-v*` line.
6. **Verify**: trigger any 5xx (or temporarily hit an endpoint with a
   malformed payload that causes one) and confirm the event appears in
   the Sentry project within a minute. A cheap deliberate test:
   `curl -X POST https://<api>/auth/register` variants won't 500 —
   simplest is to watch the dashboard for the first few days of pilot
   traffic instead of forcing an error.
7. In Sentry → Alerts: create a rule "any new issue → email" to the
   founder address.

### 2. Uptime monitor (~5 minutes)

1. Create a free monitor (UptimeRobot or BetterStack).
2. Type HTTP(S), URL = `https://<railway-api-domain>/health`,
   interval 1–5 minutes.
3. Alert channel: founder email (add SMS/Telegram if offered free).
4. Optionally add a second monitor for the frontend origin
   (`https://qift.net`).
5. **Verify**: pause the monitor target once (or wait for the first
   Railway redeploy) and confirm an alert fires + recovers.

### 3. Frontend errors (deferred, cheap to add later)

`@sentry/nextjs` on qift-ui-v2 is deliberately **not** part of A8 —
backend visibility is the pilot blocker. When wanted: one more Sentry
project (`qift-web`), `npx @sentry/wizard@latest -i nextjs`, same
DSN-env pattern on Vercel.

## Operational notes

- **Secrets discipline**: the DSN is not a secret in the classical
  sense (it can only ingest events) but keep it in env, not code.
- **PII discipline**: `sendDefaultPii: false` is enforced in code and
  pinned by a unit test (`src/instrument.spec.ts`). Do not flip it —
  request bodies on this API carry phones, addresses, and OTP codes.
- **Noise control**: if a noisy issue floods the free quota, use
  Sentry's per-issue "Ignore" rather than raising sample rates or
  filters in code.
- **CI/tests**: no DSN is ever set in CI; Sentry stays a no-op there
  by construction.
