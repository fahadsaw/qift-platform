// Store VAT-facts maker–checker (Track B3 / PE-12).
//
// Financial Constitution Ch. 14.1 (change-authority matrix row):
//   "Financial configuration (… merchant VAT facts …) | Ops |
//    Verification evidence + second person | Audited config change"
// and Ch. 14.2: "no single person silently changes a fee, a tax fact,
// or a safeguarding account."
//
// Shape: PROPOSE (facts + written evidence, audited) → APPROVE by a
// DIFFERENT operator (server-enforced SoD; applies to the Store,
// audited with before/after) or REJECT (audited). One open proposal
// per store. Applying affects FUTURE issuances only — issued invoices
// froze their own tax snapshots and are never recomputed (Ch. 7.2 /
// Rule 13.5); nothing here touches any invoice table, ever.
//
// Reference discipline (Reference Constitution Ch. 8.1): the approve
// path updates EXACTLY the four VAT-facts columns on Store — pinned by
// test; no reference column can ride along.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// Active tax jurisdictions. GCC expansion adds codes here (invariants
// §12: country-aware, never hardcoded rates — the ENGINE owns rates;
// this is only the allow-list for the recorded fact).
const ACTIVE_TAX_COUNTRIES: ReadonlySet<string> = new Set(['SA']);

const EVIDENCE_MIN_LENGTH = 8;

export type VatFactsProposalInput = {
  vatRegistered?: boolean;
  vatNumber?: string;
  pricesIncludeVat?: boolean;
  taxCountry?: string;
  evidenceNote?: string;
};

const VAT_FACTS_SELECT = {
  vatRegistered: true,
  vatNumber: true,
  pricesIncludeVat: true,
  taxCountry: true,
} as const;

@Injectable()
export class VatFactsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // Current facts + the open proposal, for the admin panel.
  async getFacts(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, ...VAT_FACTS_SELECT },
    });
    if (!store) throw new NotFoundException('store_not_found');
    const pending = await this.prisma.storeVatFactsProposal.findFirst({
      where: { storeId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    return { store, pending };
  }

  async propose(
    actorUserId: string,
    storeId: string,
    body: VatFactsProposalInput,
  ) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ...VAT_FACTS_SELECT },
    });
    if (!store) throw new NotFoundException('store_not_found');

    const evidenceNote = body.evidenceNote?.trim() ?? '';
    if (evidenceNote.length < EVIDENCE_MIN_LENGTH) {
      // Ch. 14.1: "Verification evidence" is a leg of the authority
      // row, not decoration — a change without written evidence is
      // constitutionally malformed.
      throw new BadRequestException('verification_evidence_required');
    }

    const vatRegistered = body.vatRegistered ?? store.vatRegistered;
    const vatNumber = body.vatNumber?.trim() || null;
    const pricesIncludeVat = body.pricesIncludeVat ?? store.pricesIncludeVat;
    const taxCountry = (
      body.taxCountry?.trim() || store.taxCountry
    ).toUpperCase();

    if (vatRegistered && !vatNumber) {
      // The tax engine treats registered-without-number as a data
      // fault at issuance; refuse it at the gate instead.
      throw new BadRequestException('vat_number_required_when_registered');
    }
    if (!ACTIVE_TAX_COUNTRIES.has(taxCountry)) {
      throw new BadRequestException('tax_country_not_active');
    }

    const existing = await this.prisma.storeVatFactsProposal.findFirst({
      where: { storeId, status: 'pending' },
      select: { id: true },
    });
    if (existing) throw new ConflictException('proposal_already_pending');

    const proposal = await this.prisma.storeVatFactsProposal.create({
      data: {
        storeId,
        vatRegistered,
        vatNumber,
        pricesIncludeVat,
        taxCountry,
        evidenceNote,
        proposedBy: actorUserId,
      },
    });

    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'admin.store.vat_facts.proposed',
      targetType: 'store',
      targetId: storeId,
      metadata: {
        proposalId: proposal.id,
        proposed: { vatRegistered, vatNumber, pricesIncludeVat, taxCountry },
        evidenceNote,
      },
    });
    return proposal;
  }

  async approve(actorUserId: string, storeId: string, proposalId: string) {
    const proposal = await this.prisma.storeVatFactsProposal.findFirst({
      where: { id: proposalId, storeId, status: 'pending' },
    });
    if (!proposal) throw new NotFoundException('proposal_not_found');

    // Ch. 14.2 two-person integrity — SoD is enforced HERE, above any
    // role check: holding the permission does not waive it.
    if (proposal.proposedBy === actorUserId) {
      throw new ForbiddenException('sod_maker_cannot_approve');
    }

    const before = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: VAT_FACTS_SELECT,
    });
    if (!before) throw new NotFoundException('store_not_found');

    // FUTURE issuances only: this is the ONLY write, it touches
    // exactly the four fact columns, and no invoice table is touched
    // anywhere in this service (structural + pinned by test).
    const after = await this.prisma.store.update({
      where: { id: storeId },
      data: {
        vatRegistered: proposal.vatRegistered,
        vatNumber: proposal.vatNumber,
        pricesIncludeVat: proposal.pricesIncludeVat,
        taxCountry: proposal.taxCountry,
      },
      select: VAT_FACTS_SELECT,
    });

    const decided = await this.prisma.storeVatFactsProposal.update({
      where: { id: proposal.id },
      data: {
        status: 'approved',
        decidedBy: actorUserId,
        decidedAt: new Date(),
      },
    });

    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'admin.store.vat_facts.approved',
      targetType: 'store',
      targetId: storeId,
      metadata: {
        proposalId: proposal.id,
        proposedBy: proposal.proposedBy,
        approvedBy: actorUserId,
        evidenceNote: proposal.evidenceNote,
        before,
        after,
      },
    });
    return { proposal: decided, before, after };
  }

  async reject(actorUserId: string, storeId: string, proposalId: string) {
    const proposal = await this.prisma.storeVatFactsProposal.findFirst({
      where: { id: proposalId, storeId, status: 'pending' },
    });
    if (!proposal) throw new NotFoundException('proposal_not_found');

    const decided = await this.prisma.storeVatFactsProposal.update({
      where: { id: proposal.id },
      data: {
        status: 'rejected',
        decidedBy: actorUserId,
        decidedAt: new Date(),
      },
    });
    await this.audit.record({
      actorUserId,
      actorType: 'user',
      action: 'admin.store.vat_facts.rejected',
      targetType: 'store',
      targetId: storeId,
      metadata: { proposalId: proposal.id, proposedBy: proposal.proposedBy },
    });
    return decided;
  }
}
