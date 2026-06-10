// getJwtSecret() fail-safe contract (PR 1, platform stabilization).
//
//   - JWT_SECRET set (non-blank)          → returned trimmed, any env.
//   - missing + NODE_ENV === 'production' → throws (refuses boot —
//     both call sites run at module init, so this aborts startup).
//   - missing + any other NODE_ENV        → historical dev fallback.
//
// process.env is mutated per-test and restored in afterEach so the
// suite can't leak environment state into other suites.

import { getJwtSecret } from './jwt.strategy';

describe('getJwtSecret', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  afterEach(() => {
    setEnv('JWT_SECRET', ORIGINAL_SECRET);
    setEnv('NODE_ENV', ORIGINAL_NODE_ENV);
  });

  it('returns the env secret when set, in production', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('JWT_SECRET', 'a-long-random-production-secret');
    expect(getJwtSecret()).toBe('a-long-random-production-secret');
  });

  it('trims surrounding whitespace from the env secret', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('JWT_SECRET', '  padded-secret  ');
    expect(getJwtSecret()).toBe('padded-secret');
  });

  it('THROWS in production when JWT_SECRET is missing', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('JWT_SECRET', undefined);
    expect(() => getJwtSecret()).toThrow(/refusing to boot in production/i);
  });

  it('THROWS in production when JWT_SECRET is blank/whitespace', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('JWT_SECRET', '   ');
    expect(() => getJwtSecret()).toThrow(/refusing to boot in production/i);
  });

  it('falls back to the dev literal when missing in development', () => {
    setEnv('NODE_ENV', 'development');
    setEnv('JWT_SECRET', undefined);
    expect(getJwtSecret()).toBe('qift-secret');
  });

  it('falls back to the dev literal when missing and NODE_ENV is unset (fresh checkout)', () => {
    setEnv('NODE_ENV', undefined);
    setEnv('JWT_SECRET', undefined);
    expect(getJwtSecret()).toBe('qift-secret');
  });

  it('falls back to the dev literal under jest (NODE_ENV=test) without warning noise', () => {
    setEnv('NODE_ENV', 'test');
    setEnv('JWT_SECRET', undefined);
    expect(getJwtSecret()).toBe('qift-secret');
  });

  it('prefers the env secret over the fallback outside production too', () => {
    setEnv('NODE_ENV', 'development');
    setEnv('JWT_SECRET', 'dev-override');
    expect(getJwtSecret()).toBe('dev-override');
  });
});
