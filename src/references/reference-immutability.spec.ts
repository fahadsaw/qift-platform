// Reference immutability tripwire (Track A.5).
//
// CANONICAL_REFERENCE_ARCHITECTURE.md §7: a reference is written
// exactly once, at object creation — no update path may ever touch a
// reference column. Unit specs pin the corporate services' update
// payloads directly; the personal flow (orders/gifts/store/payments)
// has no per-service prisma-mock suites, so this spec pins the SOURCE:
// it counts every occurrence of each reference field in the files that
// may legitimately mention it (allocation probe + create data + read
// projections) and fails on ANY new occurrence.
//
// If you just added a reference-field usage and landed here: adding a
// READ is fine — recount and bump the number with a comment. Adding a
// WRITE inside any update/updateMany is FORBIDDEN — references are
// immutable through status changes, cancellation, replacement, refund,
// and re-shipment. See the architecture doc before touching this.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function count(file: string, needle: string): number {
  const text = readFileSync(join(SRC, file), 'utf8');
  return text.split(needle).length - 1;
}

describe('reference immutability tripwire (source pins)', () => {
  it('orderNumber: allocation-site only in orders.service.ts; payments never touches it', () => {
    // 4 = probe where-clause + create data key + comment mention +
    // listForUser select READ (PR 7 buyer history).
    expect(count('orders/orders.service.ts', 'orderNumber')).toBe(4);
    // The payment lifecycle (processing/paid/failed) updates Order rows
    // but must NEVER carry the reference.
    expect(count('payments/payments.service.ts', 'orderNumber')).toBe(0);
  });

  it('fulfillmentNumber: allocation in gifts.service.ts; store only READS it', () => {
    // 7 = probe where-clause + allocation const + create data key +
    // four notification-body READS (received / confirm_address /
    // address_confirmed / cancelled — propagation audit close).
    expect(count('gifts/gifts.service.ts', 'fulfillmentNumber')).toBe(7);
    // 10 = type field (1) + row map key/value (2) + SIX
    // notification-body reads (all three lifecycle pairs, incl. the
    // delivered-receiver site the propagation audit caught) + the
    // ?q= exact-match FILTER (1). ALL reads — no update touches it.
    expect(count('store/store.service.ts', 'fulfillmentNumber')).toBe(10);
  });

  it('fulfillmentNumber: the auto-default sweep only READS it', () => {
    // 5 = sweep select (1) + four notification-body reads
    // (auto_fallback_blocked ×2, default_address_used ×2).
    expect(
      count('gifts/gifts-auto-default.service.ts', 'fulfillmentNumber'),
    ).toBe(5);
  });

  // ── QS (Track C PR 1 — the RC v2.0 Ch. 10.2 replacement pins) ─────
  // The v1.0 generator-refusal pin is retired by the activating
  // amendment; these are its equal-strength replacements: QS is minted
  // in EXACTLY ONE place (the settlement engine's assembly), and the
  // settlementReference column is written exactly once at creation.

  it('QS: allocated ONLY by settlement-engine assembly — nowhere else', () => {
    // 1 = the single allocateReference('QS', ...) call at assembly.
    expect(
      count('settlement/settlement-engine.service.ts', 'allocateReference('),
    ).toBe(1);
    // No other module may mint QS: generateReference('QS') appears
    // only in the reference module's own kind-check + spec.
    expect(
      count('settlement/settlement-engine.service.ts', 'generateReference'),
    ).toBe(0);
  });

  it('QN: allocated ONLY by the refunds service at credit-note issuance — nowhere else', () => {
    // 1 = the single allocateReference('QN', ...) call at issuance.
    expect(
      count('settlement/settlement-refunds.service.ts', "allocateReference("),
    ).toBe(1);
    expect(
      count('settlement/settlement-refunds.service.ts', 'generateReference'),
    ).toBe(0);
  });

  it('settlementReference: written once at create; engine only READS it afterwards', () => {
    // 21 occurrences, all read-or-create-time: allocation const +
    // uniqueness-probe where + create data key (the ONLY write) +
    // twenty-two READS — assembly marker metadata + assembly audit + the
    // batch.settlementReference reads in markFailed/retry/holdBatch/
    // supersede marker/supersede audit, and (SETTLE-2) the
    // markSettled remittance-row denormalization (key + read — a COPY
    // into the immutable remittance record, RC 14.4, never a rewrite
    // of the batch column) + completed-marker metadata + markSettled
    // audit + the frozenRecord read seam + (SETTLE-3b) the recovery-
    // posting metadata (key + read) + (Lane 2 PR 2, §26) the six
    // markSettledZeroNet READS — recovery-posting metadata (key +
    // read), completed-marker metadata (key + read), close audit
    // (key + read) — the zero-net close copies the reference into
    // its immutable postings/audit exactly like markSettled, never
    // writes it. No update path writes it — the write-once law
    // (RC Ch. 8.1/10.2 replacement pin).
    expect(
      count('settlement/settlement-engine.service.ts', 'settlementReference'),
    ).toBe(31);
  });
});
