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
    // 3 = probe where-clause + allocation const + create data key.
    expect(count('gifts/gifts.service.ts', 'fulfillmentNumber')).toBe(3);
    // 8 = type field (1) + row map key/value (2) + five
    // notification-body reads (5). ALL reads — no update touches it.
    expect(count('store/store.service.ts', 'fulfillmentNumber')).toBe(8);
  });
});
