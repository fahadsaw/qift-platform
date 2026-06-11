// ClaimService — the account-less claim flow (Corporate Foundation
// PR 5; Corporate Core v2 §6).
//
// Flow, in privacy order (F1 — THE ORDER IS THE FEATURE):
//
//   1. teaser        — token only. Returns a GENERIC payload: a
//                      masked channel hint and nothing else. No
//                      recipient name, no company, no gift. The
//                      person holding a forwarded link learns
//                      nothing about anyone.
//   2. send-otp      — OTP to the BOUND channel (snapshotted at
//                      mint). The recipient never types a channel;
//                      possession of the channel IS the identity.
//   3. verify-otp    — on success, mints a short-lived claim
//                      session and ONLY NOW reveals: identity echo
//                      ("Hi Sara — a gift from Acme"), the gift,
//                      the message. The echo enables "this isn't
//                      me" (mismatch) as a first-class exit.
//   4. address       — coverage-checked ClaimAddress. claimed is
//                      IRREVOCABLE; nobody's API reads the address
//                      back out.
//
// ANTI-ENUMERATION: missing, expired, revoked, declined, mismatch,
// and already-claimed tokens are all the same 404 claim_not_found.
// Only a live pending claim behaves differently.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OtpService } from '../otp/otp.service';
import { normalizePhone, validateMobile } from '../auth/phone-normalize';
import { matchAddressToStoreZones } from '../stores/delivery-zones';
import { hashClaimToken, maskChannel } from './claim-token';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes post-OTP

// Mirrors the fast-delivery category set used by gift confirmation
// and the auto-default sweeper — coverage is strict only for goods
// that spoil in transit.
const FAST_DELIVERY_CATEGORIES: ReadonlySet<string> = new Set([
  'flowers',
  'chocolate',
  'cake',
  'perishable',
]);

export type ClaimAddressInput = {
  fullName?: string;
  phone?: string;
  country?: string;
  region?: string;
  city?: string;
  district?: string;
  line1?: string;
  notes?: string;
};

type GiftSnapshot = {
  productId?: string;
  productName?: string;
  price?: number;
  imageUrl?: string | null;
  category?: string;
  storeId?: string;
  storeName?: string;
};

@Injectable()
export class ClaimService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private otp: OtpService,
  ) {}

  // Load the claim for a token; ONLY a live pending claim comes
  // back. Everything else — wrong token, expired, finalized — is
  // the identical 404 (anti-enumeration). Expiry is applied lazily.
  private async loadPending(token: string) {
    if (typeof token !== 'string' || token.length < 16) {
      throw new NotFoundException('claim_not_found');
    }
    const claim = await this.prisma.claimableGift.findUnique({
      where: { tokenHash: hashClaimToken(token) },
    });
    if (!claim || claim.status !== 'pending') {
      throw new NotFoundException('claim_not_found');
    }
    if (claim.expiresAt.getTime() < Date.now()) {
      await this.prisma.claimableGift.updateMany({
        where: { id: claim.id, status: 'pending' },
        data: { status: 'expired' },
      });
      throw new NotFoundException('claim_not_found');
    }
    return claim;
  }

  // Step 3+ guard: a valid, unexpired post-OTP session.
  private async loadSession(token: string, sessionToken: unknown) {
    const claim = await this.loadPending(token);
    if (
      typeof sessionToken !== 'string' ||
      !sessionToken ||
      !claim.sessionTokenHash ||
      !claim.otpVerifiedAt ||
      claim.sessionTokenHash !== hashClaimToken(sessionToken) ||
      !claim.sessionExpiresAt ||
      claim.sessionExpiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('claim_session_invalid');
    }
    return claim;
  }

  // The post-OTP payload: identity echo + gift reveal.
  private revealPayload(claim: {
    recipientName: string;
    orgDisplayName: string;
    campaignMessage: string | null;
    giftSnapshot: unknown;
    expiresAt: Date;
  }) {
    return {
      recipientName: claim.recipientName,
      orgDisplayName: claim.orgDisplayName,
      message: claim.campaignMessage,
      gift: claim.giftSnapshot,
      expiresAt: claim.expiresAt,
    };
  }

  // ── Step 1: generic teaser (F1: NOTHING identifying) ─────────────
  async teaser(token: string) {
    const claim = await this.loadPending(token);
    return {
      ok: true,
      channel: claim.channel,
      channelHint: maskChannel(claim.channel, claim.channelValue),
    };
  }

  // ── Step 2: OTP to the bound channel ─────────────────────────────
  async sendOtp(token: string) {
    const claim = await this.loadPending(token);
    // OtpService owns normalization, rate limits, lockouts, and
    // transport. The recipient never supplies the target.
    await this.otp.send({
      target: claim.channelValue,
      type: claim.channel === 'email' ? 'email' : 'phone',
    });
    return {
      ok: true,
      channelHint: maskChannel(claim.channel, claim.channelValue),
    };
  }

  // ── Step 3: possession proof → session + reveal ──────────────────
  async verifyOtp(token: string, code: unknown) {
    const claim = await this.loadPending(token);
    if (typeof code !== 'string' || !code.trim()) {
      throw new BadRequestException('code_required');
    }
    // Throws invalid_code / expired_code / otp_locked on failure.
    await this.otp.verify({ target: claim.channelValue, code: code.trim() });

    const sessionToken = randomBytes(32).toString('base64url');
    await this.prisma.claimableGift.update({
      where: { id: claim.id },
      data: {
        sessionTokenHash: hashClaimToken(sessionToken),
        sessionExpiresAt: new Date(Date.now() + SESSION_TTL_MS),
        otpVerifiedAt: claim.otpVerifiedAt ?? new Date(),
      },
    });
    return { ok: true, sessionToken, claim: this.revealPayload(claim) };
  }

  // Page-refresh re-read for an existing session (still post-OTP).
  async reveal(token: string, sessionToken: unknown) {
    const claim = await this.loadSession(token, sessionToken);
    return { ok: true, claim: this.revealPayload(claim) };
  }

  // ── First-class exits ────────────────────────────────────────────

  // "This isn't me" — the identity echo's escape hatch. Kills the
  // link; ops sees the mismatch in counters and re-checks the
  // roster row with the org.
  async notMe(token: string, sessionToken: unknown) {
    const claim = await this.loadSession(token, sessionToken);
    await this.finalize(claim.id, 'mismatch');
    await this.audit.record({
      actorUserId: null,
      actorType: 'user',
      action: 'corporate.claim.mismatch',
      targetType: 'organization',
      targetId: null,
      metadata: { claimId: claim.id, campaignId: claim.campaignId },
    });
    return { ok: true };
  }

  async decline(token: string, sessionToken: unknown) {
    const claim = await this.loadSession(token, sessionToken);
    await this.finalize(claim.id, 'declined', new Date());
    await this.audit.record({
      actorUserId: null,
      actorType: 'user',
      action: 'corporate.claim.decline',
      targetType: 'organization',
      targetId: null,
      metadata: { claimId: claim.id, campaignId: claim.campaignId },
    });
    return { ok: true };
  }

  // ── Step 4: coverage-checked address → claimed (irrevocable) ─────
  async submitAddress(
    token: string,
    sessionToken: unknown,
    body: ClaimAddressInput,
  ) {
    const claim = await this.loadSession(token, sessionToken);

    const phone = normalizePhone(body.phone);
    if (!phone || validateMobile(phone) !== null) {
      throw new BadRequestException('address_phone_invalid');
    }
    const country = body.country?.trim();
    const city = body.city?.trim();
    const line1 = body.line1?.trim();
    if (!country || !city || !line1) {
      throw new BadRequestException('address_fields_required');
    }
    const address = {
      fullName: body.fullName?.trim() || null,
      phone,
      country,
      region: body.region?.trim() || null,
      city,
      district: body.district?.trim() || null,
      line1,
      notes: body.notes?.trim() || null,
    };

    // Coverage check against the LIVE store zones for the
    // snapshotted store. Strict only for fast-delivery goods (same
    // rule as consumer gifting). A vanished store doesn't block the
    // claim — fulfillment is ops-manual in the pilot.
    const snapshot = (claim.giftSnapshot ?? {}) as GiftSnapshot;
    if (snapshot.storeId) {
      const store = await this.prisma.store.findUnique({
        where: { id: snapshot.storeId },
        select: { city: true, deliveryZones: true },
      });
      if (store) {
        let isFastDelivery = FAST_DELIVERY_CATEGORIES.has(
          (snapshot.category ?? '').toLowerCase(),
        );
        if (!isFastDelivery && snapshot.productId) {
          const product = await this.prisma.product.findUnique({
            where: { id: snapshot.productId },
            select: { isFastDelivery: true },
          });
          isFastDelivery = product?.isFastDelivery === true;
        }
        const match = matchAddressToStoreZones(
          {
            country: address.country,
            region: address.region,
            city: address.city,
            district: address.district,
          },
          { city: store.city, deliveryZones: store.deliveryZones },
          isFastDelivery,
        );
        if (!match.ok) {
          // Calm, retryable: the recipient can submit a different
          // address. Nothing is finalized.
          throw new BadRequestException('address_out_of_coverage');
        }
      }
    }

    // Address write + irrevocable flip, atomically. The conditional
    // updateMany is the irrevocability lock: a second submission
    // (or a decline racing the claim) loses cleanly.
    await this.prisma.$transaction(async (tx) => {
      const flip = await tx.claimableGift.updateMany({
        where: { id: claim.id, status: 'pending' },
        data: { status: 'claimed', claimedAt: new Date() },
      });
      if (flip.count === 0) {
        throw new BadRequestException('claim_already_finalized');
      }
      await tx.claimAddress.create({ data: { claimId: claim.id, ...address } });
    });

    // Counts-only audit — the address itself is never logged.
    await this.audit.record({
      actorUserId: null,
      actorType: 'user',
      action: 'corporate.claim.claimed',
      targetType: 'organization',
      targetId: null,
      metadata: { claimId: claim.id, campaignId: claim.campaignId },
    });
    return { ok: true, status: 'claimed' };
  }

  private async finalize(
    claimId: string,
    status: 'declined' | 'mismatch',
    declinedAt?: Date,
  ) {
    const result = await this.prisma.claimableGift.updateMany({
      where: { id: claimId, status: 'pending' },
      data: { status, ...(declinedAt ? { declinedAt } : {}) },
    });
    if (result.count === 0) {
      throw new BadRequestException('claim_already_finalized');
    }
  }
}
