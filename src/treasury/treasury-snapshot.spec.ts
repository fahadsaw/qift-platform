// Three-way Treasury Reconciliation — pure builder proofs
// (Lane 2 PR 1). SC §10.3 / FC Ch. 17.2.

import { createHash } from 'crypto';
import {
  buildTreasurySnapshot,
  TREASURY_RECON_SCOPE,
  TREASURY_SNAPSHOT_VERSION,
  type TreasuryMovement,
} from './treasury-snapshot';

const D = (day: string) => `2026-07-${day}T12:00:00.000Z`;

const move = (over: Partial<TreasuryMovement>): TreasuryMovement => ({
  ledgerId: 'led-1',
  eventType: 'invoice.payment.received',
  direction: 'in',
  amountMinor: 575000,
  valueDate: D('20'),
  recordedAt: D('20'),
  reference: 'QC-2026-00001',
  storeId: 's-1',
  evidenceRef: 'TT-9001',
  ...over,
});

const ATTEST = (balanceMinor: number) => ({
  id: 'att-1',
  balanceMinor,
  asOfDate: D('21'),
  source: 'manual_attestation',
  evidenceRef: 'STMT-2026-07-21',
});

describe('Treasury three-way snapshot (SC §10.3 — pure, deterministic)', () => {
  it('MATCHED: bank = ledger cash = obligations, day-zero through a full receipt', () => {
    const receiptIn = move({});
    const payableIn = move({
      ledgerId: 'led-2',
      eventType: 'merchant.payable.accrued',
    });
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: ATTEST(575000),
      cashMovements: [receiptIn],
      obligationMovements: [payableIn],
      excluded: [],
    });
    expect(r.status).toBe('matched');
    expect(r.ledgerCashMinor).toBe(575000);
    expect(r.obligationsMinor).toBe(575000);
    expect(r.bankVsCashMinor).toBe(0);
    expect(r.cashVsObligationsMinor).toBe(0);
    expect(r.differences).toHaveLength(0);
    expect((r.snapshot as { scope: string }).scope).toBe(TREASURY_RECON_SCOPE);
    expect((r.snapshot as { snapshotVersion: string }).snapshotVersion).toBe(
      TREASURY_SNAPSHOT_VERSION,
    );
  });

  it('PENDING: no attestation → no invented bank balance, ledger legs still computed', () => {
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: null,
      cashMovements: [move({})],
      obligationMovements: [
        move({ ledgerId: 'led-2', eventType: 'merchant.payable.accrued' }),
      ],
      excluded: [],
    });
    expect(r.status).toBe('pending');
    expect(r.bankVsCashMinor).toBeNull();
    expect(
      (r.snapshot as { legs: { bankBalanceMinor: number | null } }).legs
        .bankBalanceMinor,
    ).toBeNull();
    expect(r.ledgerCashMinor).toBe(575000);
  });

  it('MISMATCHED: unexplained bank delta is enumerated with its exact minor amount', () => {
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: ATTEST(600000), // bank says 6,000.00
      cashMovements: [move({})], // books say 5,750.00
      obligationMovements: [
        move({ ledgerId: 'led-2', eventType: 'merchant.payable.accrued' }),
      ],
      excluded: [],
    });
    expect(r.status).toBe('mismatched');
    expect(r.bankVsCashMinor).toBe(25000);
    const diff = r.differences.find((d) => d.kind === 'bank_vs_ledger_cash')!;
    expect(diff.deltaMinor).toBe(25000);
  });

  it('MISMATCHED: internal posting asymmetry names the diverging event type', () => {
    // Cash-in recorded WITHOUT its payable conversion — the exact
    // asymmetry the third leg exists to catch.
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: ATTEST(575000),
      cashMovements: [move({})],
      obligationMovements: [],
      excluded: [],
    });
    expect(r.status).toBe('mismatched');
    expect(r.cashVsObligationsMinor).toBe(575000);
    const diff = r.differences.find((d) => d.kind === 'cash_vs_obligations')!;
    expect(diff.detail).toContain('invoice.payment.received');
  });

  it('TIMING: a movement value-dated AFTER asOf is set aside and enumerated, never netted', () => {
    const remitLater: TreasuryMovement = move({
      ledgerId: 'led-3',
      eventType: 'merchant.remittance.paid',
      direction: 'out',
      valueDate: D('25'), // after asOf D(21)
      reference: 'QS-AAAA-BBBB',
      evidenceRef: 'TT-OUT-1',
    });
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: ATTEST(575000), // pre-remittance balance
      cashMovements: [move({}), remitLater],
      obligationMovements: [
        move({ ledgerId: 'led-2', eventType: 'merchant.payable.accrued' }),
        { ...remitLater, ledgerId: 'led-4' },
      ],
      excluded: [],
    });
    expect(r.status).toBe('matched'); // timing explains itself
    const snap = r.snapshot as {
      cash: { timing: TreasuryMovement[] };
    };
    expect(snap.cash.timing).toHaveLength(1);
    expect(snap.cash.timing[0].ledgerId).toBe('led-3');
  });

  it('EXCEPTION: a ledger row with no resolvable evidence is an enumerated difference, not a guess', () => {
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: ATTEST(0),
      cashMovements: [move({ valueDate: null })],
      obligationMovements: [],
      excluded: [],
    });
    expect(r.status).toBe('mismatched');
    const ex = r.differences.find((d) => d.kind === 'unresolved_evidence')!;
    expect(ex.ledgerId).toBe('led-1');
    // The unresolved movement is EXCLUDED from the balance (no guess).
    expect(r.ledgerCashMinor).toBe(0);
  });

  it('FINDING 5 PIN: an orphan row copied into both legs yields ONE unresolved_evidence difference', () => {
    const orphan = move({
      ledgerId: 'led-orphan',
      eventType: 'merchant.remittance.paid',
      direction: 'out',
      valueDate: null,
    });
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: ATTEST(0),
      cashMovements: [orphan],
      obligationMovements: [{ ...orphan }],
      excluded: [],
    });
    expect(
      r.differences.filter((d) => d.kind === 'unresolved_evidence'),
    ).toHaveLength(1);
  });

  it('NEGATIVE attested balance is itself an enumerated violation (client money is never overdrawn)', () => {
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding',
      currency: 'SAR',
      asOfDate: D('21'),
      attestation: ATTEST(-100),
      cashMovements: [],
      obligationMovements: [],
      excluded: [],
    });
    expect(r.status).toBe('mismatched');
    expect(
      r.differences.some((d) => d.kind === 'negative_bank_balance'),
    ).toBe(true);
  });

  it('DETERMINISM: shuffled input order produces byte-identical canonical JSON and hash', () => {
    const ms = [
      move({}),
      move({ ledgerId: 'led-3', eventType: 'merchant.remittance.paid', direction: 'out', amountMinor: 100000, valueDate: D('20') }),
      move({ ledgerId: 'led-5', amountMinor: 50000, valueDate: D('19') }),
    ];
    const obs = [
      move({ ledgerId: 'led-2', eventType: 'merchant.payable.accrued' }),
      move({ ledgerId: 'led-4', eventType: 'merchant.remittance.paid', direction: 'out', amountMinor: 100000, valueDate: D('20') }),
      move({ ledgerId: 'led-6', eventType: 'merchant.payable.accrued', amountMinor: 50000, valueDate: D('19') }),
    ];
    const a = buildTreasurySnapshot({
      accountType: 'safeguarding', currency: 'SAR', asOfDate: D('21'),
      attestation: ATTEST(525000),
      cashMovements: ms, obligationMovements: obs, excluded: [],
    });
    const b = buildTreasurySnapshot({
      accountType: 'safeguarding', currency: 'SAR', asOfDate: D('21'),
      attestation: ATTEST(525000),
      cashMovements: [...ms].reverse(), obligationMovements: [...obs].reverse(),
      excluded: [],
    });
    expect(a.canonical).toBe(b.canonical);
    expect(a.hash).toBe(b.hash);
    expect(a.status).toBe('matched');
  });

  it('HASH LAW: the hash is sha256 of the canonical bytes, nothing else', () => {
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding', currency: 'SAR', asOfDate: D('21'),
      attestation: ATTEST(575000),
      cashMovements: [move({})],
      obligationMovements: [
        move({ ledgerId: 'led-2', eventType: 'merchant.payable.accrued' }),
      ],
      excluded: [],
    });
    expect(r.hash).toBe(
      createHash('sha256').update(r.canonical, 'utf8').digest('hex'),
    );
  });

  it('NO PII: canonical bytes carry references and ids only — no denylisted personal fields', () => {
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding', currency: 'SAR', asOfDate: D('21'),
      attestation: ATTEST(575000),
      cashMovements: [move({})],
      obligationMovements: [
        move({ ledgerId: 'led-2', eventType: 'merchant.payable.accrued' }),
      ],
      excluded: [{ class: 'consumer_lane_payable', count: 2, amountMinor: 9000 }],
    });
    const lower = r.canonical.toLowerCase();
    for (const banned of [
      '"name"', '"phone"', '"address"', '"email"', '"recipient',
      '"city"', '"district"', '"lat"', '"lng"',
    ]) {
      expect(lower).not.toContain(banned);
    }
  });

  it('EXCLUDED classes are counted in the snapshot — nothing silently dropped', () => {
    const r = buildTreasurySnapshot({
      accountType: 'safeguarding', currency: 'SAR', asOfDate: D('21'),
      attestation: null,
      cashMovements: [], obligationMovements: [],
      excluded: [
        { class: 'operating_account_cash', count: 3, amountMinor: 51750 },
        { class: 'consumer_lane_payable', count: 5, amountMinor: 120000 },
      ],
    });
    const snap = r.snapshot as { excluded: Array<{ class: string }> };
    expect(snap.excluded.map((e) => e.class)).toEqual([
      'consumer_lane_payable',
      'operating_account_cash', // sorted deterministically
    ]);
  });
});
