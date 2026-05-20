// Unit tests for permission-checks-flag.ts — PR B-3.
//
// Pure-function tests, no Nest DI, no DB. Validates all four
// resolution paths of `arePermissionChecksEnabled()`:
//   1. Explicit env-var truthy values ('1', 'true')
//   2. Explicit env-var falsy values ('0', 'false')
//   3. Unset / invalid env-var → NODE_ENV-based default
//   4. Anything not matching the above → OFF (conservative)
//
// ENV ISOLATION
// Each test mutates `process.env` directly. The before/afterEach
// hooks snapshot and restore both relevant variables to keep tests
// hermetic — neither `RBAC_PERMISSION_CHECKS_ENABLED` nor `NODE_ENV`
// state leaks between tests, and neither leaks into the rest of the
// Jest run (which would corrupt sibling suites that depend on
// `NODE_ENV === 'test'`).

import { arePermissionChecksEnabled } from './index';

describe('arePermissionChecksEnabled', () => {
  const ORIGINAL_RBAC = process.env.RBAC_PERMISSION_CHECKS_ENABLED;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    // Restore each variable to its pre-test value, or delete it if
    // it was undefined originally. Setting to `undefined` via
    // assignment would leave the key present with string 'undefined'
    // — only `delete` truly clears it.
    if (ORIGINAL_RBAC === undefined) {
      delete process.env.RBAC_PERMISSION_CHECKS_ENABLED;
    } else {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = ORIGINAL_RBAC;
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  describe('explicit override — truthy', () => {
    it("returns true for '1'", () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(true);
    });

    it("returns true for 'true'", () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = 'true';
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(true);
    });

    it('explicit truthy override wins over NODE_ENV=production', () => {
      // Demonstrates that operator override takes priority over
      // the NODE_ENV-based default — the operator can opt in even
      // in production.
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '1';
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(true);
    });
  });

  describe('explicit override — falsy', () => {
    it("returns false for '0'", () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      process.env.NODE_ENV = 'development';
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it("returns false for 'false'", () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = 'false';
      process.env.NODE_ENV = 'development';
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it('explicit falsy override wins over NODE_ENV=development', () => {
      // Operator kill-switch path: even in dev, the operator can
      // disable explicitly and the new path stops being used.
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '0';
      process.env.NODE_ENV = 'development';
      expect(arePermissionChecksEnabled()).toBe(false);
    });
  });

  describe('NODE_ENV default — flag unset', () => {
    beforeEach(() => {
      delete process.env.RBAC_PERMISSION_CHECKS_ENABLED;
    });

    it("returns true when NODE_ENV='development'", () => {
      process.env.NODE_ENV = 'development';
      expect(arePermissionChecksEnabled()).toBe(true);
    });

    it("returns true when NODE_ENV='test'", () => {
      process.env.NODE_ENV = 'test';
      expect(arePermissionChecksEnabled()).toBe(true);
    });

    it("returns false when NODE_ENV='production'", () => {
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it('returns false when NODE_ENV is unset', () => {
      delete process.env.NODE_ENV;
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it('returns false for unrecognized NODE_ENV values (conservative)', () => {
      process.env.NODE_ENV = 'staging';
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it('returns false for empty-string NODE_ENV', () => {
      process.env.NODE_ENV = '';
      expect(arePermissionChecksEnabled()).toBe(false);
    });
  });

  describe('invalid override values fall through to NODE_ENV', () => {
    // Any RBAC_PERMISSION_CHECKS_ENABLED value not in the accepted
    // set is treated as "unset" — the helper falls through to the
    // NODE_ENV default rather than picking either side.

    it("'TRUE' (uppercase) is treated as unset and uses NODE_ENV", () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = 'TRUE';
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it("'yes' is treated as unset and uses NODE_ENV", () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = 'yes';
      process.env.NODE_ENV = 'development';
      expect(arePermissionChecksEnabled()).toBe(true);
    });

    it('empty string is treated as unset and uses NODE_ENV', () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '';
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it('numeric 2 (as string) is treated as unset and uses NODE_ENV', () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = '2';
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(false);
    });
  });

  describe('production safety', () => {
    // Single-property assertion that production never silently
    // enables the new path. Multiple guards rely on this default.
    it('production is OFF by default with no override', () => {
      delete process.env.RBAC_PERMISSION_CHECKS_ENABLED;
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(false);
    });

    it('production with garbage override is OFF', () => {
      process.env.RBAC_PERMISSION_CHECKS_ENABLED = 'totally invalid';
      process.env.NODE_ENV = 'production';
      expect(arePermissionChecksEnabled()).toBe(false);
    });
  });
});
