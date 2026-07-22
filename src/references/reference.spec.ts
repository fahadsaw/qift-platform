// Canonical reference grammar tests (Track A.5 PR 1).
//
// Pinned, in constitutional order:
//   * ALPHABET — ambiguity-free: no 0/O/1/I/L anywhere, ever.
//   * SHAPE — random refs are QX-XXXX-XXXX; sequential is QC-YYYY-NNNNN.
//   * KIND DISCIPLINE — generateReference refuses sequential (QC) and
//     reserved (QS) prefixes; the sequential formatter refuses random.
//   * NORMALIZATION — case-insensitive, dash/space/punctuation-blind,
//     round-trips to exactly one canonical form; garbage → null.
//   * ALLOCATION — bounded collision retry; exhaustion throws.
//   * NO PII / NO SECRETS — a reference is 8 random chars + prefix;
//     nothing else can leak because nothing else goes in.

import {
  REFERENCE_ALPHABET,
  REFERENCE_PREFIXES,
  allocateReference,
  formatSequentialReference,
  generateReference,
  isCanonicalReference,
  normalizeReference,
} from './reference';

describe('reference grammar', () => {
  describe('alphabet', () => {
    it('has 31 symbols and excludes every ambiguous character', () => {
      expect(REFERENCE_ALPHABET).toHaveLength(31);
      for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
        expect(REFERENCE_ALPHABET).not.toContain(ambiguous);
      }
    });

    it('generated references never contain ambiguous characters', () => {
      for (let i = 0; i < 200; i++) {
        const ref = generateReference('QP');
        expect(ref).toMatch(
          /^QP-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/,
        );
      }
    });
  });

  describe('prefix registry', () => {
    it('registers exactly the constitutional prefixes with their kinds', () => {
      expect(Object.keys(REFERENCE_PREFIXES).sort()).toEqual([
        'QB',
        'QC',
        'QD',
        'QF',
        'QG',
        'QN',
        'QP',
        'QS',
      ]);
      expect(REFERENCE_PREFIXES.QP.kind).toBe('random');
      expect(REFERENCE_PREFIXES.QB.kind).toBe('random');
      expect(REFERENCE_PREFIXES.QG.kind).toBe('random');
      expect(REFERENCE_PREFIXES.QF.kind).toBe('random');
      expect(REFERENCE_PREFIXES.QC.kind).toBe('sequential');
      expect(REFERENCE_PREFIXES.QS.kind).toBe('random'); // ACTIVE per RC v2.0
      expect(REFERENCE_PREFIXES.QN.kind).toBe('random'); // ACTIVE per RC v3.0
      expect(REFERENCE_PREFIXES.QD.kind).toBe('sequential'); // ACTIVE per RC v4.0
    });

    it('QN is ACTIVE (RC v3.0): random credit-note reference generates', () => {
      // Allocation discipline (one QN per credit note, minted only at
      // issuance in the refunds service) is pinned in the settlement
      // rules spec; here the grammar itself.
      const ref = generateReference('QN');
      expect(ref).toMatch(/^QN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
      expect(normalizeReference('qn-abcd-efgh')).toBe('QN-ABCD-EFGH');
    });

    it('refuses to randomly generate the sequential invoice prefix (QC)', () => {
      expect(() => generateReference('QC')).toThrow(/not_random.*sequential/i);
    });

    it('QD is ACTIVE (RC v4.0): sequential Qift credit-note series formats and parses; random generation refuses', () => {
      expect(() => generateReference('QD')).toThrow(/not_random.*sequential/i);
      expect(formatSequentialReference('QD', 2026, 1)).toBe('QD-2026-00001');
      expect(normalizeReference('qd 2026 00001')).toBe('QD-2026-00001');
    });

    it('QS is ACTIVE (RC v2.0): random settlement-batch reference generates', () => {
      // The v1.0 refusal pin is retired BY the activating amendment
      // (RC v2.0 Ch. 10.2) and replaced by allocation-at-assembly
      // discipline pinned in the settlement engine spec: QS only at
      // batch assembly, immutable across retries, renewed on
      // re-assembly, never on simulations.
      const ref = generateReference('QS');
      expect(ref).toMatch(/^QS-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    });

    it('refuses to format a random prefix as sequential', () => {
      expect(() => formatSequentialReference('QP', 2026, 1)).toThrow(
        /not_sequential/,
      );
    });
  });

  describe('sequential formatting (legal invoice series)', () => {
    it('formats QC-YYYY-NNNNN zero-padded', () => {
      expect(formatSequentialReference('QC', 2026, 1)).toBe('QC-2026-00001');
      expect(formatSequentialReference('QC', 2026, 123)).toBe('QC-2026-00123');
      expect(formatSequentialReference('QC', 2027, 99999)).toBe(
        'QC-2027-99999',
      );
    });

    it('grows past the pad without truncation', () => {
      expect(formatSequentialReference('QC', 2026, 1234567)).toBe(
        'QC-2026-1234567',
      );
    });

    it('rejects non-positive values and absurd years', () => {
      expect(() => formatSequentialReference('QC', 2026, 0)).toThrow(
        /value_invalid/,
      );
      expect(() => formatSequentialReference('QC', 199, 1)).toThrow(
        /year_invalid/,
      );
    });
  });

  describe('normalization (search input contract)', () => {
    it('accepts lowercase, missing dashes, spaces, and stray punctuation', () => {
      for (const input of [
        'QB-7XKM-3NPQ',
        'qb-7xkm-3npq',
        'QB7XKM3NPQ',
        'qb 7xkm 3npq',
        ' qb.7xkm.3npq ',
        'QB—7XKM—3NPQ', // em-dash from a phone keyboard
      ]) {
        expect(normalizeReference(input)).toBe('QB-7XKM-3NPQ');
      }
    });

    it('normalizes sequential invoice numbers the same way', () => {
      for (const input of ['qc-2026-00007', 'QC202600007', 'qc 2026 00007']) {
        expect(normalizeReference(input)).toBe('QC-2026-00007');
      }
    });

    it('parses reserved QS shape (future settlement refs round-trip)', () => {
      expect(normalizeReference('qs-abcd-efgh')).toBe('QS-ABCD-EFGH');
    });

    it('returns null for garbage, wrong prefixes, wrong lengths, ambiguous chars', () => {
      for (const bad of [
        '',
        'hello',
        'QX-7XKM-3NPQ', // unregistered prefix
        'QB-7XKM', // too short
        'QB-7XKM-3NPQ-EXTRA', // too long
        'QB-0XKM-3NPQ', // 0 not in alphabet
        'QB-IXKM-3NPQ', // I not in alphabet
        'QC-26-00007', // malformed year
        'c0ffee',
        'clzy8p2qk0000356m9k2l4x8v', // a cuid is NOT a reference
      ]) {
        expect(normalizeReference(bad)).toBeNull();
      }
    });

    it('isCanonicalReference is strict about stored form', () => {
      expect(isCanonicalReference('QB-7XKM-3NPQ')).toBe(true);
      expect(isCanonicalReference('qb-7xkm-3npq')).toBe(false);
      expect(isCanonicalReference('QB7XKM3NPQ')).toBe(false);
    });
  });

  describe('allocation (collision retry)', () => {
    it('returns the first free candidate', async () => {
      const isTaken = jest.fn().mockResolvedValue(false);
      const ref = await allocateReference('QG', isTaken);
      expect(normalizeReference(ref)).toBe(ref);
      expect(ref.startsWith('QG-')).toBe(true);
      expect(isTaken).toHaveBeenCalledTimes(1);
    });

    it('retries past collisions', async () => {
      const isTaken = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false);
      const ref = await allocateReference('QF', isTaken);
      expect(ref.startsWith('QF-')).toBe(true);
      expect(isTaken).toHaveBeenCalledTimes(3);
    });

    it('throws after exhausting bounded retries — never degrades silently', async () => {
      const isTaken = jest.fn().mockResolvedValue(true);
      await expect(allocateReference('QP', isTaken)).rejects.toThrow(
        /allocation_exhausted: QP/,
      );
      expect(isTaken).toHaveBeenCalledTimes(5);
    });

    it('candidate space sanity: no duplicates across a large sample', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 5000; i++) {
        seen.add(generateReference('QP'));
      }
      // 5k draws from 8.5e11 — a duplicate here means the RNG is broken.
      expect(seen.size).toBe(5000);
    });
  });
});
