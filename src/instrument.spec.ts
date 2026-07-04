// instrument.ts gating tests (Track A8 / PE-08).
//
// The contract under test is the ENV GATE, not Sentry itself: without
// SENTRY_DSN the process must not initialize Sentry at all (dev / CI /
// tests stay offline); with a DSN it must initialize with PII off and
// tracing off by default.

import * as Sentry from '@sentry/nestjs';
import { initSentry } from './instrument';

jest.mock('@sentry/nestjs', () => ({
  init: jest.fn(),
}));

describe('initSentry (env gate)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('is a NO-OP without SENTRY_DSN — never calls Sentry.init', () => {
    expect(initSentry()).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('initializes with the DSN when set — PII off, tracing off by default', () => {
    process.env.SENTRY_DSN = 'https://key@o0.ingest.sentry.io/0';
    process.env.NODE_ENV = 'production';
    expect(initSentry()).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith({
      dsn: 'https://key@o0.ingest.sentry.io/0',
      environment: 'production',
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
  });

  it('SENTRY_ENVIRONMENT wins over NODE_ENV; sample rate is env-tunable', () => {
    process.env.SENTRY_DSN = 'https://key@o0.ingest.sentry.io/0';
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.25';
    initSentry();
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'staging',
        tracesSampleRate: 0.25,
      }),
    );
  });

  it('NEVER enables sendDefaultPii — request bodies carry phones, addresses, OTPs', () => {
    process.env.SENTRY_DSN = 'https://key@o0.ingest.sentry.io/0';
    initSentry();
    const arg = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(arg.sendDefaultPii).toBe(false);
  });
});
