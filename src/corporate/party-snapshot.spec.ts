import {
  buildMerchantSellerSnapshot,
  buildOrgBuyerSnapshot,
  buildQiftSellerSnapshot,
} from './party-snapshot';

const QIFT_ENV_KEYS = [
  'QIFT_LEGAL_NAME',
  'QIFT_CR_NUMBER',
  'QIFT_VAT_NUMBER',
  'QIFT_TAX_COUNTRY',
] as const;

describe('party snapshots (FIN-2)', () => {
  describe('buildOrgBuyerSnapshot (the company)', () => {
    it('captures the org legal identity with partyType organization', () => {
      const snap = buildOrgBuyerSnapshot('org-1', {
        legalName: 'Alwadi Trading Co LLC',
        crNumber: '1010101010',
        vatNumber: '300000000000003',
      });
      expect(snap).toEqual({
        partyType: 'organization',
        orgId: 'org-1',
        legalName: 'Alwadi Trading Co LLC',
        crNumber: '1010101010',
        vatNumber: '300000000000003',
        country: 'SA',
      });
    });

    it('records nulls (never invents identity) when the org row is missing', () => {
      const snap = buildOrgBuyerSnapshot('org-gone', null);
      expect(snap).toEqual({
        partyType: 'organization',
        orgId: 'org-gone',
        legalName: null,
        crNumber: null,
        vatNumber: null,
        country: 'SA',
      });
    });
  });

  describe('buildQiftSellerSnapshot (Qift, env-configured)', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of QIFT_ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of QIFT_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('unconfigured: nulls + configured=false — never a made-up legal name', () => {
      const snap = buildQiftSellerSnapshot();
      expect(snap).toEqual({
        partyType: 'qift',
        legalName: null,
        crNumber: null,
        vatNumber: null,
        country: 'SA',
        configured: false,
      });
    });

    it('configured: freezes the env-provided legal identity', () => {
      process.env.QIFT_LEGAL_NAME = 'Qift Information Technology Co';
      process.env.QIFT_CR_NUMBER = '1010999999';
      process.env.QIFT_VAT_NUMBER = '311111111111113';
      const snap = buildQiftSellerSnapshot();
      expect(snap).toEqual({
        partyType: 'qift',
        legalName: 'Qift Information Technology Co',
        crNumber: '1010999999',
        vatNumber: '311111111111113',
        country: 'SA',
        configured: true,
      });
    });

    it('reads env at call time, so a config change applies to the NEXT issuance only', () => {
      const before = buildQiftSellerSnapshot();
      process.env.QIFT_LEGAL_NAME = 'Qift Information Technology Co';
      const after = buildQiftSellerSnapshot();
      // The earlier snapshot object is untouched by the config change —
      // frozen-at-issuance semantics.
      expect(before.legalName).toBeNull();
      expect(before.configured).toBe(false);
      expect(after.legalName).toBe('Qift Information Technology Co');
      expect(after.configured).toBe(true);
    });
  });

  describe('buildMerchantSellerSnapshot (the merchant, legal seller)', () => {
    it('captures the store legal identity with partyType merchant', () => {
      const snap = buildMerchantSellerSnapshot('store-1', {
        name: 'Rosary',
        legalEntityName: 'Rosary Flowers Est.',
        commercialRegistrationNumber: '4030303030',
        vatNumber: '310000000000003',
        taxCountry: 'SA',
      });
      expect(snap).toEqual({
        partyType: 'merchant',
        storeId: 'store-1',
        legalName: 'Rosary Flowers Est.',
        displayName: 'Rosary',
        crNumber: '4030303030',
        vatNumber: '310000000000003',
        country: 'SA',
      });
    });

    it('records nulls when the store row is missing, keeping the storeId', () => {
      const snap = buildMerchantSellerSnapshot('store-gone', null);
      expect(snap).toEqual({
        partyType: 'merchant',
        storeId: 'store-gone',
        legalName: null,
        displayName: null,
        crNumber: null,
        vatNumber: null,
        country: 'SA',
      });
    });
  });
});
