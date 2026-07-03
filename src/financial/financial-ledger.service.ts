// FinancialLedgerService — the append-only write + read API over the
// FinancialLedgerEntry substrate (PR 2, dark-launched).
//
// APPEND-ONLY BY CONTRACT: the only write path is record(). There is no
// update / delete / updateMany / deleteMany method anywhere in this
// class, and none is ever added — corrections are expressed as new,
// compensating entries, never mutations of history.
//
// FAILURE POSTURE (differs from AuditService on purpose): the audit
// trail is best-effort so a bookkeeping hiccup never fails a user
// action. The FINANCIAL ledger is authoritative — a silently-dropped
// entry is a money hole — so record() validates strictly and lets a
// persistence error propagate. (Nothing writes to it yet; this is the
// contract PR 3 will build on.)
//
// PII: metadata is operator-supplied context and MUST NOT carry
// recipient address / location / phone data. record() strips a denylist
// of sensitive keys (recursively) before persisting.

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type LedgerDirection = 'credit' | 'debit';

export type RecordLedgerInput = {
  eventType: string; // high-level category, e.g. 'order.captured'
  reasonCode: string; // specific machine code, e.g. 'QIFT_SERVICE_FEE'
  actorType: string; // 'system' | 'admin' | 'user' | 'psp'
  actorId?: string | null; // plain-TEXT, null for system events
  amount: number; // positive magnitude
  currency: string; // ISO-ish code; normalised to uppercase
  direction: LedgerDirection; // 'credit' | 'debit'
  counterpartyType?: string | null; // e.g. 'merchant' | 'qift' | 'sender'
  orderId?: string | null;
  paymentId?: string | null;
  campaignId?: string | null;
  orgId?: string | null;
  storeId?: string | null;
  metadata?: Record<string, unknown> | null;
  // FIN-4 — deterministic `${eventType}:${anchorId}` key (see
  // financial-events.ts). When present, a duplicate write returns the
  // EXISTING row instead of creating or throwing: retries, repairs and
  // backfills are safe by construction.
  idempotencyKey?: string | null;
};

// Metadata keys that must never reach the ledger. Recipient address /
// geolocation / phone are the load-bearing privacy invariants (F1/F7,
// employer-blind). Matched case-insensitively, recursively.
const SENSITIVE_METADATA_KEYS = new Set(
  [
    'address',
    'addressline',
    'addressline1',
    'addressline2',
    'line1',
    'line2',
    'street',
    'building',
    'buildingnumber',
    'district',
    'neighborhood',
    'city',
    'region',
    'postalcode',
    'zip',
    'phone',
    'phonenumber',
    'mobile',
    'recipientaddress',
    'recipientphone',
    'lat',
    'lng',
    'latitude',
    'longitude',
    'coordinates',
    'geo',
  ].map((k) => k.toLowerCase()),
);

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_METADATA_KEYS.has(k.toLowerCase())) continue; // drop it
      out[k] = stripSensitive(v);
    }
    return out;
  }
  return value;
}

// Public so producers (and tests) can sanitise/inspect independently.
export function sanitizeLedgerMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (metadata == null) return null;
  return stripSensitive(metadata) as Record<string, unknown>;
}

@Injectable()
export class FinancialLedgerService {
  constructor(private prisma: PrismaService) {}

  // Append a single ledger entry. The ONLY write path.
  async record(input: RecordLedgerInput) {
    if (
      typeof input.amount !== 'number' ||
      !Number.isFinite(input.amount) ||
      input.amount <= 0
    ) {
      throw new BadRequestException(
        'ledger amount must be a positive, finite number',
      );
    }

    const currency = (input.currency ?? '').trim().toUpperCase();
    if (!currency) {
      throw new BadRequestException('ledger currency is required');
    }

    if (input.direction !== 'credit' && input.direction !== 'debit') {
      throw new BadRequestException(
        "ledger direction must be 'credit' or 'debit'",
      );
    }

    const eventType = (input.eventType ?? '').trim();
    const reasonCode = (input.reasonCode ?? '').trim();
    const actorType = (input.actorType ?? '').trim();
    if (!eventType || !reasonCode || !actorType) {
      throw new BadRequestException(
        'ledger eventType, reasonCode and actorType are required',
      );
    }

    const metadata = sanitizeLedgerMetadata(input.metadata);

    const idempotencyKey = input.idempotencyKey?.trim() || null;

    try {
      return await this.prisma.financialLedgerEntry.create({
        data: {
          eventType,
          reasonCode,
          actorType,
          actorId: input.actorId ?? null,
          amount: input.amount,
          currency,
          direction: input.direction,
          counterpartyType: input.counterpartyType ?? null,
          orderId: input.orderId ?? null,
          paymentId: input.paymentId ?? null,
          campaignId: input.campaignId ?? null,
          orgId: input.orgId ?? null,
          storeId: input.storeId ?? null,
          metadata:
            metadata == null
              ? Prisma.JsonNull
              : (metadata as Prisma.InputJsonValue),
          idempotencyKey,
        },
      });
    } catch (err) {
      // FIN-4 — a P2002 on the EXPLICIT key means this exact posting
      // already exists: idempotent success, return the original row.
      // Any other unique collision (e.g. the legacy (orderId,
      // reasonCode) anchor) keeps propagating so existing callers'
      // P2002 handling stays exactly as it was.
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.financialLedgerEntry.findUnique({
          where: { idempotencyKey },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  // FIN-4 — read helper for reconciliation: the row for a deterministic
  // idempotency key, or null when the posting is missing.
  findByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.financialLedgerEntry.findUnique({
      where: { idempotencyKey },
    });
  }

  // ── Read helpers (append-only; count/query-friendly over indexed cols) ──

  findByOrder(orderId: string) {
    return this.prisma.financialLedgerEntry.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findByStore(storeId: string) {
    return this.prisma.financialLedgerEntry.findMany({
      where: { storeId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findByCampaign(campaignId: string) {
    return this.prisma.financialLedgerEntry.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'asc' },
    });
  }

  countByReasonCode(reasonCode: string) {
    return this.prisma.financialLedgerEntry.count({ where: { reasonCode } });
  }
}
