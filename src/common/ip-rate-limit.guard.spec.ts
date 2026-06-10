// IpRateLimitGuard unit tests (PR 3, platform stabilization).
//
// CONTRACT
//   - Routes without @IpRateLimit metadata pass through untouched.
//   - Within the window, up to `max` requests per IP per bucket pass.
//   - Request max+1 throws 429 with the stable code 'rate_limited'.
//   - Distinct IPs have independent budgets.
//   - Distinct buckets have independent budgets for the same IP.
//   - A missing req.ip shares the conservative 'unknown' budget.

import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IP_RATE_LIMIT_KEY,
  IpRateLimitGuard,
  type IpRateLimitConfig,
} from './ip-rate-limit.guard';

// Minimal ExecutionContext stand-in: the guard only touches
// getHandler() and switchToHttp().getRequest().
function makeContext(ip: string | undefined, handler: () => void) {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
  } as unknown as ExecutionContext;
}

describe('IpRateLimitGuard', () => {
  let guard: IpRateLimitGuard;
  let reflector: Reflector;

  // Each test gets its own handler identity + config via the real
  // Reflector metadata mechanism, exactly as SetMetadata stores it.
  const makeHandler = (config?: IpRateLimitConfig) => {
    const handler = () => undefined;
    if (config) {
      Reflect.defineMetadata(IP_RATE_LIMIT_KEY, config, handler);
    }
    return handler;
  };

  beforeEach(() => {
    IpRateLimitGuard.resetForTests();
    reflector = new Reflector();
    guard = new IpRateLimitGuard(reflector);
  });

  it('passes routes that carry no rate-limit metadata', () => {
    const handler = makeHandler(undefined);
    for (let i = 0; i < 50; i++) {
      expect(guard.canActivate(makeContext('1.2.3.4', handler))).toBe(true);
    }
  });

  it('allows up to max requests, then throws 429 rate_limited', () => {
    const handler = makeHandler({
      bucket: 'test-bucket',
      max: 3,
      windowMs: 60_000,
    });

    for (let i = 0; i < 3; i++) {
      expect(guard.canActivate(makeContext('1.2.3.4', handler))).toBe(true);
    }

    let thrown: unknown;
    try {
      guard.canActivate(makeContext('1.2.3.4', handler));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    const http = thrown as HttpException;
    expect(http.getStatus()).toBe(429);
    expect((http.getResponse() as { code?: string }).code).toBe(
      'rate_limited',
    );
  });

  it('gives distinct IPs independent budgets', () => {
    const handler = makeHandler({
      bucket: 'per-ip',
      max: 2,
      windowMs: 60_000,
    });

    expect(guard.canActivate(makeContext('10.0.0.1', handler))).toBe(true);
    expect(guard.canActivate(makeContext('10.0.0.1', handler))).toBe(true);
    expect(() =>
      guard.canActivate(makeContext('10.0.0.1', handler)),
    ).toThrow();

    // A different caller is unaffected by the first caller's burn.
    expect(guard.canActivate(makeContext('10.0.0.2', handler))).toBe(true);
  });

  it('gives distinct buckets independent budgets for the same IP', () => {
    const loginHandler = makeHandler({
      bucket: 'login',
      max: 1,
      windowMs: 60_000,
    });
    const otpHandler = makeHandler({
      bucket: 'otp',
      max: 1,
      windowMs: 60_000,
    });

    expect(guard.canActivate(makeContext('10.0.0.9', loginHandler))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(makeContext('10.0.0.9', loginHandler)),
    ).toThrow();

    // Burning the login bucket leaves the otp bucket intact.
    expect(guard.canActivate(makeContext('10.0.0.9', otpHandler))).toBe(true);
  });

  it('missing req.ip falls into the shared "unknown" budget (no bypass)', () => {
    const handler = makeHandler({
      bucket: 'no-ip',
      max: 1,
      windowMs: 60_000,
    });

    expect(guard.canActivate(makeContext(undefined, handler))).toBe(true);
    // Second address-less request shares the same bucket → limited.
    expect(() =>
      guard.canActivate(makeContext(undefined, handler)),
    ).toThrow();
  });
});
