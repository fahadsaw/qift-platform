// Unit specs for the sandbox-mode helper. Pure module — no DI,
// no Prisma. The whole surface is two functions; the spec covers
// the full env-var x body-value decision matrix plus the safer
// fail-closed defaults documented in the module.

import { isSandboxOnlyModeEnabled, resolveSandboxFlag } from './sandbox-mode';

describe('isSandboxOnlyModeEnabled', () => {
  // Restore env between tests so a stray write in one spec can't
  // contaminate the next one.
  const originalEnv = process.env.SANDBOX_ONLY_MODE;
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SANDBOX_ONLY_MODE;
    } else {
      process.env.SANDBOX_ONLY_MODE = originalEnv;
    }
  });

  it('returns true when env var is the literal string "true"', () => {
    process.env.SANDBOX_ONLY_MODE = 'true';
    expect(isSandboxOnlyModeEnabled()).toBe(true);
  });

  it('returns false when env var is undefined', () => {
    // The production-correct default. A missing env var must NEVER
    // be interpreted as sandbox — production deploys would silently
    // become sandbox by accident.
    delete process.env.SANDBOX_ONLY_MODE;
    expect(isSandboxOnlyModeEnabled()).toBe(false);
  });

  it('returns false when env var is empty string', () => {
    process.env.SANDBOX_ONLY_MODE = '';
    expect(isSandboxOnlyModeEnabled()).toBe(false);
  });

  it('returns false when env var is "false"', () => {
    process.env.SANDBOX_ONLY_MODE = 'false';
    expect(isSandboxOnlyModeEnabled()).toBe(false);
  });

  it('returns false for non-boolean truthy strings ("1", "yes", "TRUE")', () => {
    // Strict equality to the literal 'true' is by design — any
    // ambiguity in env-var typing fails safe to live mode.
    for (const value of ['1', 'yes', 'YES', 'TRUE', 'True', 'on']) {
      process.env.SANDBOX_ONLY_MODE = value;
      expect(isSandboxOnlyModeEnabled()).toBe(false);
    }
  });

  it('reads the env var on every call (not cached)', () => {
    // Test code (and ops in staging) need to flip the flag at
    // runtime. The helper must observe the latest value.
    process.env.SANDBOX_ONLY_MODE = 'true';
    expect(isSandboxOnlyModeEnabled()).toBe(true);
    process.env.SANDBOX_ONLY_MODE = 'false';
    expect(isSandboxOnlyModeEnabled()).toBe(false);
    process.env.SANDBOX_ONLY_MODE = 'true';
    expect(isSandboxOnlyModeEnabled()).toBe(true);
  });
});

describe('resolveSandboxFlag', () => {
  const originalEnv = process.env.SANDBOX_ONLY_MODE;
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SANDBOX_ONLY_MODE;
    } else {
      process.env.SANDBOX_ONLY_MODE = originalEnv;
    }
  });

  describe('SANDBOX_ONLY_MODE=true (closed-beta deploy)', () => {
    beforeEach(() => {
      process.env.SANDBOX_ONLY_MODE = 'true';
    });

    it('forces sandbox=true regardless of body=undefined', () => {
      // Closed-beta invariant: a missing isSandbox in the request
      // body must NOT produce a live order. The env flag wins.
      expect(resolveSandboxFlag(undefined)).toBe(true);
    });

    it('forces sandbox=true regardless of body=true', () => {
      expect(resolveSandboxFlag(true)).toBe(true);
    });

    it('forces sandbox=true regardless of body=false', () => {
      // The frontend cannot opt OUT of sandbox during closed beta.
      // This is the load-bearing safety property — no path from
      // closed-beta deploy to live-order creation.
      expect(resolveSandboxFlag(false)).toBe(true);
    });
  });

  describe('SANDBOX_ONLY_MODE=false (post-beta deploy)', () => {
    beforeEach(() => {
      process.env.SANDBOX_ONLY_MODE = 'false';
    });

    it('returns false when body omits isSandbox (production default)', () => {
      // Production-correct default: unflagged writes are live.
      expect(resolveSandboxFlag(undefined)).toBe(false);
    });

    it('returns false when body explicitly sets isSandbox=false', () => {
      expect(resolveSandboxFlag(false)).toBe(false);
    });

    it('returns true when body explicitly sets isSandbox=true', () => {
      // Post-beta opt-in path: staging / QA can mark a single
      // order sandbox even on a live deploy.
      expect(resolveSandboxFlag(true)).toBe(true);
    });
  });

  describe('SANDBOX_ONLY_MODE unset (production default)', () => {
    beforeEach(() => {
      delete process.env.SANDBOX_ONLY_MODE;
    });

    it('returns false when body omits isSandbox', () => {
      // The two production-default code paths produce live rows.
      // A deploy that never set the env var must behave like
      // SANDBOX_ONLY_MODE=false.
      expect(resolveSandboxFlag(undefined)).toBe(false);
    });

    it('returns true only when body opts in explicitly', () => {
      expect(resolveSandboxFlag(true)).toBe(true);
      expect(resolveSandboxFlag(false)).toBe(false);
    });
  });

  describe('non-boolean body values (defense in depth)', () => {
    // TypeScript makes these unreachable from well-typed callers,
    // but `body` is a JSON object at the HTTP boundary and could
    // arrive with anything. The helper's `=== true` check
    // collapses anything ambiguous into false.
    beforeEach(() => {
      delete process.env.SANDBOX_ONLY_MODE;
    });

    it('coerces non-boolean truthy values to false', () => {
      // Cast forces past the TS type guard — emulates a malformed
      // request body at runtime.
      expect(resolveSandboxFlag('true' as unknown as boolean)).toBe(false);
      expect(resolveSandboxFlag(1 as unknown as boolean)).toBe(false);
      expect(resolveSandboxFlag({} as unknown as boolean)).toBe(false);
    });
  });
});
