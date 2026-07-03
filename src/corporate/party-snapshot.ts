// Party snapshots (FIN-2) — the legal identity of an invoice's buyer
// and seller, FROZEN at issuance.
//
// Both invoice tables are deliberately FK-free (plain-TEXT orgId /
// storeId) so they survive org/store purges for regulatory retention —
// which means a surviving invoice must carry its parties' legal
// identity ITSELF. These builders capture that identity once, at the
// commitment point; old invoices are never re-hydrated from live
// Organization/Store rows (which may have changed or been purged).
//
// Pure functions: unit-testable, no Prisma, no side effects. The
// services read the rows and pass the fields in.
//
// PRIVACY: business identity ONLY — legal names, CR/VAT numbers,
// country. Never employee identity, personal addresses, phones, or
// claim choices. billingEmail / billingAddress are deliberately NOT
// snapshotted in FIN-2 (they join with the ZATCA document work).

// The buyer — the corporate customer (Organization).
export type BuyerPartySnapshot = {
  partyType: 'organization';
  orgId: string;
  legalName: string | null;
  crNumber: string | null;
  vatNumber: string | null;
  // Organization has no country column yet; the corporate pilot is
  // KSA-only, so 'SA' is recorded explicitly rather than implied.
  country: string;
};

// The seller on the Qift SERVICE invoice — Qift itself.
export type QiftPartySnapshot = {
  partyType: 'qift';
  legalName: string | null;
  crNumber: string | null;
  vatNumber: string | null;
  country: string;
  // false while the QIFT_LEGAL_* env vars are unset — the snapshot
  // records honestly that Qift's legal identity was not yet configured
  // instead of freezing a made-up name. Legal onboarding sets the env
  // vars once Qift's CR/VAT registrations are final.
  configured: boolean;
};

// The seller on the MERCHANT (goods) invoice — the merchant.
export type MerchantPartySnapshot = {
  partyType: 'merchant';
  storeId: string;
  legalName: string | null; // Store.legalEntityName
  displayName: string | null; // Store.name — trade name, for rendering
  crNumber: string | null; // Store.commercialRegistrationNumber
  vatNumber: string | null;
  country: string; // Store.taxCountry
};

export function buildOrgBuyerSnapshot(
  orgId: string,
  org: {
    legalName?: string | null;
    crNumber?: string | null;
    vatNumber?: string | null;
  } | null,
): BuyerPartySnapshot {
  return {
    partyType: 'organization',
    orgId,
    legalName: org?.legalName ?? null,
    crNumber: org?.crNumber ?? null,
    vatNumber: org?.vatNumber ?? null,
    country: 'SA',
  };
}

// Qift's own legal identity — config, not schema: there is exactly one
// Qift, and its registrations live in the deploy environment. Read at
// call time (not module load) so a config change applies on the next
// issuance without a rebuild, and so tests can exercise both states.
export function buildQiftSellerSnapshot(): QiftPartySnapshot {
  const legalName = process.env.QIFT_LEGAL_NAME?.trim() || null;
  const crNumber = process.env.QIFT_CR_NUMBER?.trim() || null;
  const vatNumber = process.env.QIFT_VAT_NUMBER?.trim() || null;
  return {
    partyType: 'qift',
    legalName,
    crNumber,
    vatNumber,
    country: process.env.QIFT_TAX_COUNTRY?.trim() || 'SA',
    configured: legalName !== null,
  };
}

export function buildMerchantSellerSnapshot(
  storeId: string,
  store: {
    name?: string | null;
    legalEntityName?: string | null;
    commercialRegistrationNumber?: string | null;
    vatNumber?: string | null;
    taxCountry?: string | null;
  } | null,
): MerchantPartySnapshot {
  return {
    partyType: 'merchant',
    storeId,
    legalName: store?.legalEntityName ?? null,
    displayName: store?.name ?? null,
    crNumber: store?.commercialRegistrationNumber ?? null,
    vatNumber: store?.vatNumber ?? null,
    country: store?.taxCountry ?? 'SA',
  };
}
