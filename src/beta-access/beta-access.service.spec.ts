// BetaAccessService unit tests — Closed Beta Gate.
//
// Pure unit tests: BetaAccessService is constructed directly with a
// hand-rolled PrismaService mock (no Nest DI, no DB). Two surfaces are
// covered:
//
//   1. decideRegistration — the read-only gate decision. Asserts every
//      branch of the summary's matrix:
//        gate-off / allowlist (email | domain | phone) / no-code /
//        valid-code / unknown / disabled / expired / exhausted, plus
//        code normalisation.
//   2. applyRedemption — the atomic redemption performed inside the
//      caller's transaction. Asserts the conditional-updateMany WHERE
//      shape, the no-op modes, and the lost-race rollback path.
//
// The gate flag is process.env.BETA_GATE_ENABLED; each test sets it
// explicitly and afterEach restores the original value, so these tests
// are independent of NODE_ENV.

import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BetaAccessService } from './beta-access.service';
import type { PrismaService } from '../prisma/prisma.service';

type PrismaMock = {
  betaAllowlistEntry: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
  betaInviteCode: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

type CodeRow = {
  id: string;
  code: string;
  label: string | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | null;
  disabledAt: Date | null;
  createdBy: string;
  createdAt: Date;
};

const codeRow = (over: Partial<CodeRow> = {}): CodeRow => ({
  id: 'code-1',
  code: 'QIFT-AAAA-BBBB',
  label: null,
  maxUses: null,
  usedCount: 0,
  expiresAt: null,
  disabledAt: null,
  createdBy: 'admin-1',
  createdAt: new Date('2026-05-01T00:00:00Z'),
  ...over,
});

// Run an awaited call expected to reject with a 403 HttpException and
// return its stable `code`. Fails the test if the call doesn't throw.
async function denialCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HttpException) {
      expect(e.getStatus()).toBe(403);
      return (e.getResponse() as { code: string }).code;
    }
    throw e;
  }
  throw new Error('expected the call to throw, but it resolved');
}

describe('BetaAccessService', () => {
  let prisma: PrismaMock;
  let service: BetaAccessService;
  const ORIGINAL_FLAG = process.env.BETA_GATE_ENABLED;

  beforeEach(() => {
    prisma = {
      betaAllowlistEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'al-new', ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      betaInviteCode: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'code-new', ...data })),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 'code-1', ...data })),
      },
    };
    service = new BetaAccessService(
      prisma as unknown as PrismaService,
      // PR 7 — audit stub; admin-mutation rows are pinned implicitly
      // by it never throwing.
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.BETA_GATE_ENABLED;
    else process.env.BETA_GATE_ENABLED = ORIGINAL_FLAG;
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────
  describe('decideRegistration — gate OFF', () => {
    it('returns { mode: open } and never touches the DB', async () => {
      delete process.env.BETA_GATE_ENABLED;
      const decision = await service.decideRegistration({
        email: 'a@b.com',
        phone: '+966500000000',
        betaCode: undefined,
      });
      expect(decision).toEqual({ mode: 'open' });
      expect(prisma.betaAllowlistEntry.findFirst).not.toHaveBeenCalled();
      expect(prisma.betaInviteCode.findUnique).not.toHaveBeenCalled();
    });

    it('treats BETA_GATE_ENABLED=false / 0 as OFF', async () => {
      for (const v of ['false', '0', 'nope', '']) {
        process.env.BETA_GATE_ENABLED = v;
        const decision = await service.decideRegistration({
          email: null,
          phone: '+966500000000',
        });
        expect(decision).toEqual({ mode: 'open' });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('decideRegistration — gate ON, allowlist', () => {
    beforeEach(() => {
      process.env.BETA_GATE_ENABLED = 'true';
    });

    it('admits when the allowlist has a hit → { mode: allowlist }', async () => {
      prisma.betaAllowlistEntry.findFirst.mockResolvedValue({ id: 'al-1' });
      const decision = await service.decideRegistration({
        email: 'vip@press.com',
        phone: '+966500000000',
        betaCode: undefined, // no code needed when allowlisted
      });
      expect(decision).toEqual({ mode: 'allowlist' });
      // Allowlisted → the invite-code lookup is never reached.
      expect(prisma.betaInviteCode.findUnique).not.toHaveBeenCalled();
    });

    it('probes the allowlist with email-exact + email-domain + phone', async () => {
      prisma.betaAllowlistEntry.findFirst.mockResolvedValue({ id: 'al-1' });
      await service.decideRegistration({
        email: 'vip@press.com',
        phone: '+966500000000',
      });
      const arg = prisma.betaAllowlistEntry.findFirst.mock.calls[0][0] as {
        where: { OR: Prisma.BetaAllowlistEntryWhereInput[] };
      };
      expect(arg.where.OR).toEqual(
        expect.arrayContaining([
          { kind: 'phone', value: '+966500000000' },
          { kind: 'email', value: 'vip@press.com' },
          { kind: 'email_domain', value: 'press.com' },
        ]),
      );
    });

    it('probes phone-only when no email is supplied', async () => {
      prisma.betaAllowlistEntry.findFirst.mockResolvedValue(null);
      await denialCode(() =>
        service.decideRegistration({ email: null, phone: '+966500000000' }),
      );
      const arg = prisma.betaAllowlistEntry.findFirst.mock.calls[0][0] as {
        where: { OR: Prisma.BetaAllowlistEntryWhereInput[] };
      };
      expect(arg.where.OR).toEqual([{ kind: 'phone', value: '+966500000000' }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('decideRegistration — gate ON, invite codes', () => {
    beforeEach(() => {
      process.env.BETA_GATE_ENABLED = 'true';
    });

    it('no allowlist + no code → beta_required', async () => {
      expect(
        await denialCode(() =>
          service.decideRegistration({
            email: 'a@b.com',
            phone: '+966500000000',
            betaCode: undefined,
          }),
        ),
      ).toBe('beta_required');
    });

    it('valid capped code → { mode: code, codeId, maxUses }', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(
        codeRow({ id: 'c9', maxUses: 5, usedCount: 2 }),
      );
      const decision = await service.decideRegistration({
        email: null,
        phone: '+966500000000',
        betaCode: 'QIFT-AAAA-BBBB',
      });
      expect(decision).toEqual({ mode: 'code', codeId: 'c9', maxUses: 5 });
    });

    it('valid unlimited code → maxUses null', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(
        codeRow({ id: 'c9', maxUses: null, usedCount: 999 }),
      );
      const decision = await service.decideRegistration({
        email: null,
        phone: '+966500000000',
        betaCode: 'QIFT-AAAA-BBBB',
      });
      expect(decision).toEqual({ mode: 'code', codeId: 'c9', maxUses: null });
    });

    it('normalises the code before lookup (trim + uppercase)', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(codeRow());
      await service.decideRegistration({
        email: null,
        phone: '+966500000000',
        betaCode: '  qift-aaaa-bbbb  ',
      });
      expect(prisma.betaInviteCode.findUnique).toHaveBeenCalledWith({
        where: { code: 'QIFT-AAAA-BBBB' },
      });
    });

    it('unknown code → beta_code_invalid', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(null);
      expect(
        await denialCode(() =>
          service.decideRegistration({
            email: null,
            phone: '+966500000000',
            betaCode: 'NOPE',
          }),
        ),
      ).toBe('beta_code_invalid');
    });

    it('disabled code → beta_code_invalid (no "exists but off" signal)', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(
        codeRow({ disabledAt: new Date('2026-05-01T00:00:00Z') }),
      );
      expect(
        await denialCode(() =>
          service.decideRegistration({
            email: null,
            phone: '+966500000000',
            betaCode: 'QIFT-AAAA-BBBB',
          }),
        ),
      ).toBe('beta_code_invalid');
    });

    it('expired code → beta_code_expired', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(
        codeRow({ expiresAt: new Date(Date.now() - 60_000) }),
      );
      expect(
        await denialCode(() =>
          service.decideRegistration({
            email: null,
            phone: '+966500000000',
            betaCode: 'QIFT-AAAA-BBBB',
          }),
        ),
      ).toBe('beta_code_expired');
    });

    it('exhausted code (usedCount >= maxUses) → beta_code_exhausted', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(
        codeRow({ maxUses: 3, usedCount: 3 }),
      );
      expect(
        await denialCode(() =>
          service.decideRegistration({
            email: null,
            phone: '+966500000000',
            betaCode: 'QIFT-AAAA-BBBB',
          }),
        ),
      ).toBe('beta_code_exhausted');
    });

    it('allowlist takes precedence over a missing/invalid code', async () => {
      // Allowlisted users never need a code, even if they don't supply
      // one. The code lookup must not even run.
      prisma.betaAllowlistEntry.findFirst.mockResolvedValue({ id: 'al-1' });
      const decision = await service.decideRegistration({
        email: 'vip@press.com',
        phone: '+966500000000',
        betaCode: undefined,
      });
      expect(decision).toEqual({ mode: 'allowlist' });
      expect(prisma.betaInviteCode.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('applyRedemption', () => {
    type TxMock = {
      betaInviteCode: { updateMany: jest.Mock };
      betaInviteRedemption: { create: jest.Mock };
    };
    let tx: TxMock;

    beforeEach(() => {
      tx = {
        betaInviteCode: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        betaInviteRedemption: { create: jest.fn().mockResolvedValue({}) },
      };
    });

    const run = (decision: Parameters<BetaAccessService['applyRedemption']>[1]) =>
      service.applyRedemption(
        tx as unknown as Prisma.TransactionClient,
        decision,
        'user-1',
      );

    it('is a no-op for { mode: open }', async () => {
      await run({ mode: 'open' });
      expect(tx.betaInviteCode.updateMany).not.toHaveBeenCalled();
      expect(tx.betaInviteRedemption.create).not.toHaveBeenCalled();
    });

    it('is a no-op for { mode: allowlist }', async () => {
      await run({ mode: 'allowlist' });
      expect(tx.betaInviteCode.updateMany).not.toHaveBeenCalled();
      expect(tx.betaInviteRedemption.create).not.toHaveBeenCalled();
    });

    it('capped code → conditional increment + redemption row', async () => {
      await run({ mode: 'code', codeId: 'c9', maxUses: 5 });
      expect(tx.betaInviteCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'c9', disabledAt: null, usedCount: { lt: 5 } },
        data: { usedCount: { increment: 1 } },
      });
      expect(tx.betaInviteRedemption.create).toHaveBeenCalledWith({
        data: { codeId: 'c9', userId: 'user-1' },
      });
    });

    it('unlimited code → WHERE omits the usedCount guard', async () => {
      await run({ mode: 'code', codeId: 'c9', maxUses: null });
      expect(tx.betaInviteCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'c9', disabledAt: null },
        data: { usedCount: { increment: 1 } },
      });
    });

    it('lost race (updateMany count 0) → beta_code_exhausted, no redemption row', async () => {
      tx.betaInviteCode.updateMany.mockResolvedValue({ count: 0 });
      const code = await denialCode(() =>
        run({ mode: 'code', codeId: 'c9', maxUses: 5 }),
      );
      expect(code).toBe('beta_code_exhausted');
      expect(tx.betaInviteRedemption.create).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('createCode (admin)', () => {
    it('auto-generates a QIFT-prefixed code when none supplied', async () => {
      const created = await service.createCode({}, 'admin-1');
      const arg = prisma.betaInviteCode.create.mock.calls[0][0] as {
        data: { code: string; createdBy: string; maxUses: number | null };
      };
      expect(arg.data.code).toMatch(/^QIFT-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(arg.data.createdBy).toBe('admin-1');
      expect(arg.data.maxUses).toBeNull();
      expect(created).toBeDefined();
    });

    it('normalises an operator-supplied code', async () => {
      await service.createCode({ code: ' launch-2026 ' }, 'admin-1');
      const arg = prisma.betaInviteCode.create.mock.calls[0][0] as {
        data: { code: string };
      };
      expect(arg.data.code).toBe('LAUNCH-2026');
    });

    it('rejects maxUses < 1', async () => {
      await expect(
        service.createCode({ maxUses: 0 }, 'admin-1'),
      ).rejects.toThrow('beta_max_uses_invalid');
      await expect(
        service.createCode({ maxUses: -3 }, 'admin-1'),
      ).rejects.toThrow('beta_max_uses_invalid');
      expect(prisma.betaInviteCode.create).not.toHaveBeenCalled();
    });

    it('rejects an unparseable expiresAt', async () => {
      await expect(
        service.createCode({ expiresAt: 'not-a-date' }, 'admin-1'),
      ).rejects.toThrow('beta_expires_at_invalid');
    });

    it('maps a unique-constraint collision to beta_code_taken', async () => {
      prisma.betaInviteCode.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.createCode({ code: 'DUPE' }, 'admin-1'),
      ).rejects.toThrow('beta_code_taken');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('setCodeDisabled (admin)', () => {
    it('404s for an unknown id', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(null);
      await expect(service.setCodeDisabled('admin-1', 'missing', true)).rejects.toThrow(
        'beta_code_not_found',
      );
    });

    it('stamps disabledAt when disabling, clears it when enabling', async () => {
      prisma.betaInviteCode.findUnique.mockResolvedValue(codeRow());
      await service.setCodeDisabled('admin-1', 'code-1', true);
      let arg = prisma.betaInviteCode.update.mock.calls[0][0] as {
        data: { disabledAt: Date | null };
      };
      expect(arg.data.disabledAt).toBeInstanceOf(Date);

      prisma.betaInviteCode.update.mockClear();
      await service.setCodeDisabled('admin-1', 'code-1', false);
      arg = prisma.betaInviteCode.update.mock.calls[0][0] as {
        data: { disabledAt: Date | null };
      };
      expect(arg.data.disabledAt).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('addAllowlistEntry (admin)', () => {
    it('rejects an unknown kind', async () => {
      await expect(
        service.addAllowlistEntry({ kind: 'fax', value: 'x' }, 'admin-1'),
      ).rejects.toThrow('beta_allowlist_kind_invalid');
      expect(prisma.betaAllowlistEntry.create).not.toHaveBeenCalled();
    });

    it('normalises an exact email to lowercase', async () => {
      await service.addAllowlistEntry(
        { kind: 'email', value: '  VIP@Press.com ' },
        'admin-1',
      );
      const arg = prisma.betaAllowlistEntry.create.mock.calls[0][0] as {
        data: { value: string };
      };
      expect(arg.data.value).toBe('vip@press.com');
    });

    it('strips a leading @ from an email_domain and lowercases it', async () => {
      await service.addAllowlistEntry(
        { kind: 'email_domain', value: '@Press.COM' },
        'admin-1',
      );
      const arg = prisma.betaAllowlistEntry.create.mock.calls[0][0] as {
        data: { value: string };
      };
      expect(arg.data.value).toBe('press.com');
    });

    it('normalises a phone to E.164', async () => {
      await service.addAllowlistEntry(
        { kind: 'phone', value: '0501234567' },
        'admin-1',
      );
      const arg = prisma.betaAllowlistEntry.create.mock.calls[0][0] as {
        data: { value: string };
      };
      expect(arg.data.value).toBe('+966501234567');
    });

    it('rejects an email with no domain', async () => {
      await expect(
        service.addAllowlistEntry({ kind: 'email', value: 'nobody' }, 'admin-1'),
      ).rejects.toThrow('beta_allowlist_value_invalid');
    });

    it('rejects an email_domain with no dot', async () => {
      await expect(
        service.addAllowlistEntry(
          { kind: 'email_domain', value: 'localhost' },
          'admin-1',
        ),
      ).rejects.toThrow('beta_allowlist_value_invalid');
    });

    it('rejects an unparseable phone', async () => {
      await expect(
        service.addAllowlistEntry({ kind: 'phone', value: 'abc' }, 'admin-1'),
      ).rejects.toThrow('beta_allowlist_value_invalid');
    });

    it('maps a unique-constraint collision to beta_allowlist_duplicate', async () => {
      prisma.betaAllowlistEntry.create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.addAllowlistEntry(
          { kind: 'email', value: 'dupe@x.com' },
          'admin-1',
        ),
      ).rejects.toThrow('beta_allowlist_duplicate');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('removeAllowlistEntry (admin)', () => {
    it('404s for an unknown id', async () => {
      prisma.betaAllowlistEntry.findUnique.mockResolvedValue(null);
      await expect(service.removeAllowlistEntry('admin-1', 'missing')).rejects.toThrow(
        'beta_allowlist_not_found',
      );
    });

    it('deletes an existing entry', async () => {
      prisma.betaAllowlistEntry.findUnique.mockResolvedValue({ id: 'al-1' });
      const res = await service.removeAllowlistEntry('admin-1', 'al-1');
      expect(prisma.betaAllowlistEntry.delete).toHaveBeenCalledWith({
        where: { id: 'al-1' },
      });
      expect(res).toEqual({ ok: true });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('isGateEnabled / getStatus', () => {
    it('reflects the env flag', () => {
      process.env.BETA_GATE_ENABLED = 'true';
      expect(service.isGateEnabled()).toBe(true);
      expect(service.getStatus()).toEqual({ gateEnabled: true });
      process.env.BETA_GATE_ENABLED = '0';
      expect(service.isGateEnabled()).toBe(false);
      expect(service.getStatus()).toEqual({ gateEnabled: false });
    });
  });
});
