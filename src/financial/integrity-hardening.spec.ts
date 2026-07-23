// Lane 2 PR 3 — Financial Integrity Hardening: cross-cutting proofs.
//
// Scope A (guaranteed audit), Scope B (DB append-only source pins),
// Scope E (PayoutEvent retirement census), Scope F (no fabricated
// payout figures), Scope G (one consumption path), Scope H (3-decimal
// currency refusal). The live DB trigger proof runs against a real
// Postgres via scripts/verify-append-only.mjs (gate step); here the
// migration SOURCE is pinned so the triggers cannot silently vanish.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { asCurrencyCode } from '../settlement/settlement-calculator';
import type { PrismaService } from '../prisma/prisma.service';

const API_ROOT = join(__dirname, '..', '..');
const SRC = join(API_ROOT, 'src');
const MIGRATION = join(
  API_ROOT,
  'prisma',
  'migrations',
  '20260724150000_financial_integrity_hardening',
  'migration.sql',
);

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

describe('Scope B — database-level append-only protection (source pins)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('the forbid-mutation trigger function exists and RAISEs', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION qift_forbid_mutation()');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('append_only_violation');
  });

  it.each([
    'FinancialLedgerEntry',
    'AuditLog',
    'CreditNoteVersion',
    'SettlementStatementRecord',
    'SettlementStatementSignature',
    'SettlementReplayRecord',
    'SettlementRemittance',
    'SettlementApproval',
    'SettlementExecutionPreview',
    'PaymentReceipt',
    'TreasuryAttestation',
    'TreasuryInternalTransfer',
    'SettlementRefund',
  ])('%s carries a BEFORE UPDATE OR DELETE forbid trigger', (table) => {
    const re = new RegExp(
      `BEFORE UPDATE OR DELETE ON "${table}"\\s*\\n\\s*FOR EACH ROW EXECUTE FUNCTION qift_forbid_mutation\\(\\)`,
    );
    expect(sql).toMatch(re);
  });

  it('at most ONE completed internal transfer per settlement (partial unique, finding 3)', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "TreasuryInternalTransfer_completed_settlement_key"',
    );
    expect(sql).toContain(`WHERE "status" = 'completed'`);
  });

  it('the stateful-by-constitution tables are documented, not protected', () => {
    for (const stateful of [
      'SettlementBatch',
      'SettlementItem',
      'SettlementReceivable',
      'TreasuryReconciliation',
      'RefundRequest',
      'NumberSequence',
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`BEFORE UPDATE OR DELETE ON "${stateful}"`),
      );
      expect(sql).toContain(stateful); // named in the stateful list
    }
    const doc = readFileSync(
      join(API_ROOT, 'docs', 'APPEND_ONLY_PROTECTION.md'),
      'utf8',
    );
    expect(doc).toContain('SettlementBatch');
    expect(doc).toContain('TreasuryReconciliation');
  });

  it('application services still expose no update/delete paths for protected tables', () => {
    const sources = walkSources(SRC);
    const accessors = [
      'auditLog',
      'paymentReceipt',
      'settlementRemittance',
      'settlementApproval',
      'settlementExecutionPreview',
      'settlementReplayRecord',
      'settlementStatementSignature',
      'settlementStatementRecord',
      'creditNoteVersion',
      'financialLedgerEntry',
      'treasuryAttestation',
      'treasuryInternalTransfer',
      'settlementRefund',
    ];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      for (const t of accessors) {
        for (const op of ['.update(', '.updateMany(', '.delete(', '.deleteMany(', '.upsert(']) {
          expect({ file, hit: src.includes(`${t}${op}`) }).toEqual({
            file,
            hit: false,
          });
        }
      }
    }
  });
});

describe('Scope A — guaranteed financial audit', () => {
  function auditWorld() {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      auditLog: {
        create: jest.fn().mockImplementation(({ data }: never) => {
          const d = data as Record<string, unknown>;
          if (rows.some((r) => r.auditKey === d.auditKey)) {
            return Promise.reject(
              Object.assign(new Error('unique'), { code: 'P2002' }),
            );
          }
          rows.push(d);
          return Promise.resolve({ id: `a-${rows.length}` });
        }),
      },
    };
    return { service: new AuditService(prisma as unknown as PrismaService), rows, prisma };
  }

  const INPUT = {
    auditKey: 'finance.receipt.recorded:rcpt-1',
    actorUserId: 'fin-1',
    actorType: 'user' as const,
    action: 'finance.receipt.recorded',
    targetType: 'store' as const,
    targetId: 's-1',
    metadata: { receiptId: 'rcpt-1', bankReference: 'TT-1' },
  };

  it('retries NEVER duplicate: the deterministic key collides and the existing row stands', async () => {
    const w = auditWorld();
    await w.service.recordGuaranteed(INPUT);
    await w.service.recordGuaranteed(INPUT); // retry — resolves, no dup
    expect(w.rows).toHaveLength(1);
  });

  it('NO swallow: a non-collision failure THROWS to the caller (tx rollback / loud retry)', async () => {
    const w = auditWorld();
    (w.prisma.auditLog.create as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(w.service.recordGuaranteed(INPUT)).rejects.toThrow('db down');
    expect(w.rows).toHaveLength(0);
  });

  it('a financial mutation cannot succeed while its audit fails: the assembly lane propagates the audit error', () => {
    // Source pin: the engine's assembly audit is INSIDE the
    // $transaction callback — its failure rolls the batch back.
    const engine = readFileSync(
      join(SRC, 'settlement', 'settlement-engine.service.ts'),
      'utf8',
    );
    const txStart = engine.indexOf('settlementBatch.create');
    const auditAt = engine.indexOf(
      'auditKey: `settlement.batch.assembled:',
    );
    const txEnd = engine.indexOf('return created;', txStart);
    expect(txStart).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(txStart);
    expect(auditAt).toBeLessThan(txEnd); // in-tx, before the commit
  });

  it('PII is stripped from guaranteed audit metadata (denylist posture)', async () => {
    const w = auditWorld();
    await w.service.recordGuaranteed({
      ...INPUT,
      auditKey: 'x:1',
      metadata: {
        receiptId: 'r-1',
        recipientName: 'SHOULD-VANISH',
        phone: '+9665xxxxxx',
        address: { city: 'Riyadh' },
        nested: { email: 'x@y.z', keep: 'ok' },
      },
    });
    const meta = w.rows[0].metadata as Record<string, unknown>;
    expect(meta.recipientName).toBeUndefined();
    expect(meta.phone).toBeUndefined();
    expect(meta.address).toBeUndefined();
    expect((meta.nested as Record<string, unknown>).email).toBeUndefined();
    expect((meta.nested as Record<string, unknown>).keep).toBe('ok');
    expect(meta.receiptId).toBe('r-1');
  });

  it('an empty audit key refuses — every guaranteed audit is occurrence-anchored', async () => {
    const w = auditWorld();
    await expect(
      w.service.recordGuaranteed({ ...INPUT, auditKey: '  ' }),
    ).rejects.toThrow('audit_key_required');
  });
});

describe('Scope E — PayoutEvent retired as a financial truth source', () => {
  it('NO production source writes PayoutEvent (census pin)', () => {
    const sources = walkSources(SRC);
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      for (const op of ['payoutEvent.create', 'payoutEvent.update', 'payoutEvent.upsert', 'payoutEvent.delete']) {
        expect({ file, hit: src.includes(op) }).toEqual({ file, hit: false });
      }
    }
  });

  it('the legacy readers mark themselves superseded', () => {
    const controller = readFileSync(
      join(SRC, 'admin', 'admin.controller.ts'),
      'utf8',
    );
    expect(controller).toContain('legacy: true');
    expect(controller).toContain('supersededBy');
    expect(controller).not.toContain("recordPayoutEvent");
  });
});

describe('Scope F — no fabricated merchant payout figures', () => {
  const store = readFileSync(join(SRC, 'store', 'store.service.ts'), 'utf8');

  it('the payouts response is an honest orders/revenue summary — no paid/pending/net finality', () => {
    expect(store).toContain("kind: 'orders_revenue_summary'");
    expect(store).toContain('authoritative: false');
    expect(store).toContain('Not a payout statement');
    // The fabricated finality fields are gone from the summary.
    expect(store).not.toContain('paid: 0');
    expect(store).not.toContain('pending: round2(netPayable)');
    expect(store).not.toContain('platformFeePercent');
  });

  it('no derived percentage fee exists outside the versioned FeeEngine', () => {
    // The old fallback multiplied gross by a rate at read time.
    expect(store).not.toContain('gross * PLATFORM_FEE_PCT');
    expect(store).not.toContain('PLATFORM_FEE_PCT');
  });
});

describe('Scope G — one recovery-consumption implementation', () => {
  const engine = readFileSync(
    join(SRC, 'settlement', 'settlement-engine.service.ts'),
    'utf8',
  );

  it('both terminal lanes call consumeRecoveryAllocation; no inline consumption remains', () => {
    const calls = engine.match(/this\.consumeRecoveryAllocation\(/g) ?? [];
    expect(calls).toHaveLength(2); // markSettled + markSettledZeroNet
    // The amount-pin appears EXACTLY twice: the assembly STAGING
    // guard and the shared CONSUMPTION helper — never a third,
    // lane-local copy.
    const pins = engine.match(/amountRecovered: alloc\.amountRecoveredAtPlan,/g) ?? [];
    expect(pins).toHaveLength(2);
  });
});

describe('Scope H — 3-decimal settlement currencies refuse explicitly', () => {
  it.each(['KWD', 'BHD', 'OMR'])(
    '%s cannot enter a 2-decimal settlement path (never silently rounded)',
    (code) => {
      expect(() => asCurrencyCode(code)).toThrow(
        'settlement_currency_scale_unsupported',
      );
    },
  );

  it('supported 2-decimal currencies still pass', () => {
    for (const ok of ['SAR', 'AED', 'QAR']) {
      expect(asCurrencyCode(ok)).toBe(ok);
    }
  });
});
