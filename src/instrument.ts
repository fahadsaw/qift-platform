// Sentry bootstrap (Track A8 / PE-08). MUST be the first import in
// main.ts — Sentry patches Node internals (http, etc.) and anything
// imported before it escapes instrumentation.
//
// ENV-GATED NO-OP: without SENTRY_DSN this file does nothing at all —
// local dev, CI, and tests never talk to Sentry and need no config.
// Activation is a founder step (see docs/OBSERVABILITY_RUNBOOK.md):
// create the Sentry project, set SENTRY_DSN on Railway, redeploy.
import * as Sentry from '@sentry/nestjs';

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    // Off by default — error capture is the A8 goal; performance
    // tracing is opt-in via env once there's traffic worth sampling.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // PII discipline: default OFF. Request bodies on this API carry
    // phones, addresses, and OTP codes — never ship them to a third
    // party. Sentry gets stack traces + sanitized request metadata.
    sendDefaultPii: false,
  });
  return true;
}

initSentry();
