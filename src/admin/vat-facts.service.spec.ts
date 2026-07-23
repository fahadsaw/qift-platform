// VAT-facts maker–checker tests (Track B3 / PE-12).
//
// Pinned, in constitutional order (Financial Constitution Ch. 14):
//   * EVIDENCE — a proposal without written verification evidence is
//     refused ("Verification evidence + second person" is the
//     authority row, not decoration).
//   * VALIDATION — registered-without-number refused at the gate;
//     inactive tax country refused; one open proposal per store.
//   * SoD — the maker can NEVER approve their own proposal, even with
//     the permission (server-enforced above RBAC).
//   * FUTURE-ONLY + IMMUTABILITY — approval updates EXACTLY the four
//     VAT-fact columns on Store; the mock has NO invoice delegates, so
//     any invoice touch would crash structurally; no reference column
//     can ride the update payload.
//   * AUDIT — proposed/approved/rejected each audited; approval carries
//     both actors, evidence, and before/after facts.

import { VatFactsService } from './vat-facts.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const STORE_FACTS = {
  vatRegistered: false,
  vatNumber: null,
  pricesIncludeVat: true,
  taxCountry: 'SA',
};

function mk(opts: { pending?: unknown } = {}) {
  const prisma = {
    store: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 's-1', name: 'Dar Alteeb', ...STORE_FACTS }),
      update: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ ...data })),
    },
    storeVatFactsProposal: {
      findFirst: jest.fn().mockResolvedValue(opts.pending ?? null),
      create: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 'prop-1', status: 'pending', ...data }),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 'prop-1', ...data }),
        ),
    },
    // Deliberately NO invoice delegates: if this service ever reached
    // for corporateInvoice/merchantInvoice, the test would crash —
    // issued documents are immutable (future-issuances-only, Ch. 7.2).
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordGuaranteed: jest.fn().mockResolvedValue(undefined),
  };
  const service = new VatFactsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { prisma, audit, service };
}

const VALID = {
  vatRegistered: true,
  vatNumber: '310000000000003',
  pricesIncludeVat: true,
  taxCountry: 'SA',
  evidenceNote: 'VAT cert 310000000000003 verified via ZATCA portal',
};

describe('VatFactsService (Track B3 / PE-12)', () => {
  it('refuses a proposal without written verification evidence', async () => {
    const { prisma, service } = mk();
    await expect(
      service.propose('ops-1', 's-1', { ...VALID, evidenceNote: '  ' }),
    ).rejects.toThrow('verification_evidence_required');
    expect(prisma.storeVatFactsProposal.create).not.toHaveBeenCalled();
  });

  it('refuses registered-without-number and inactive tax countries', async () => {
    const { service } = mk();
    await expect(
      service.propose('ops-1', 's-1', { ...VALID, vatNumber: '' }),
    ).rejects.toThrow('vat_number_required_when_registered');
    await expect(
      service.propose('ops-1', 's-1', { ...VALID, taxCountry: 'AE' }),
    ).rejects.toThrow('tax_country_not_active');
  });

  it('allows one open proposal per store', async () => {
    const { service } = mk({ pending: { id: 'prop-0' } });
    await expect(service.propose('ops-1', 's-1', VALID)).rejects.toThrow(
      'proposal_already_pending',
    );
  });

  it('proposing records the frozen facts + evidence and audits them', async () => {
    const { audit, service } = mk();
    const out = await service.propose('ops-1', 's-1', VALID);
    expect(out.status).toBe('pending');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.store.vat_facts.proposed',
        targetId: 's-1',
        metadata: expect.objectContaining({
          proposed: {
            vatRegistered: true,
            vatNumber: '310000000000003',
            pricesIncludeVat: true,
            taxCountry: 'SA',
          },
          evidenceNote: VALID.evidenceNote,
        }),
      }),
    );
  });

  it('SoD: the maker can NEVER approve their own proposal', async () => {
    const { prisma, service } = mk({
      pending: {
        id: 'prop-1',
        storeId: 's-1',
        status: 'pending',
        proposedBy: 'ops-1',
        ...VALID,
      },
    });
    await expect(service.approve('ops-1', 's-1', 'prop-1')).rejects.toThrow(
      'sod_maker_cannot_approve',
    );
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('a DIFFERENT operator approves: exactly the four fact columns are written; audit carries both actors + before/after', async () => {
    const { prisma, audit, service } = mk({
      pending: {
        id: 'prop-1',
        storeId: 's-1',
        status: 'pending',
        proposedBy: 'ops-1',
        vatRegistered: true,
        vatNumber: '310000000000003',
        pricesIncludeVat: false,
        taxCountry: 'SA',
        evidenceNote: VALID.evidenceNote,
      },
    });
    const out = await service.approve('ops-2', 's-1', 'prop-1');

    const updateData = prisma.store.update.mock.calls[0][0].data;
    // IMMUTABILITY pin: exactly the four VAT-fact columns — nothing
    // else (no reference column, no status, no name) can ride along.
    expect(Object.keys(updateData).sort()).toEqual([
      'pricesIncludeVat',
      'taxCountry',
      'vatNumber',
      'vatRegistered',
    ]);
    expect(out.after).toEqual({
      vatRegistered: true,
      vatNumber: '310000000000003',
      pricesIncludeVat: false,
      taxCountry: 'SA',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.store.vat_facts.approved',
        metadata: expect.objectContaining({
          proposedBy: 'ops-1',
          approvedBy: 'ops-2',
          evidenceNote: VALID.evidenceNote,
          // (the shared mock returns the full row for every select;
          // the live path selects exactly the four facts)
          before: expect.objectContaining(STORE_FACTS),
          after: {
            vatRegistered: true,
            vatNumber: '310000000000003',
            pricesIncludeVat: false,
            taxCountry: 'SA',
          },
        }),
      }),
    );
  });

  it('reject closes the proposal without touching the Store', async () => {
    const { prisma, audit, service } = mk({
      pending: {
        id: 'prop-1',
        storeId: 's-1',
        status: 'pending',
        proposedBy: 'ops-1',
      },
    });
    const out = await service.reject('ops-2', 's-1', 'prop-1');
    expect(out.status).toBe('rejected');
    expect(prisma.store.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.store.vat_facts.rejected' }),
    );
  });
});
