// Unit specs for the notification-producer privacy helper.
//
// Single rule: surprise gifts mask `productName` + similar
// product-revealing strings in receiver-facing notification
// bodies UNTIL the gift reaches `delivered`. Sender-side
// notifications never mask (the sender chose the product).

import {
  bodyForReceiverGiftUpdate,
  shouldMaskGiftBody,
} from './notification-privacy';

describe('shouldMaskGiftBody', () => {
  describe('non-surprise gifts (mask never applies)', () => {
    for (const status of [
      'pending_address',
      'address_confirmed',
      'default_address_used',
      'preparing',
      'shipped',
      'delivered',
      'cancelled',
    ]) {
      it(`returns false at status=${status}`, () => {
        expect(shouldMaskGiftBody({ isSurprise: false, status })).toBe(false);
      });
    }
  });

  describe('surprise gifts', () => {
    it('masks at pending_address', () => {
      expect(
        shouldMaskGiftBody({ isSurprise: true, status: 'pending_address' }),
      ).toBe(true);
    });
    it('masks at address_confirmed', () => {
      expect(
        shouldMaskGiftBody({ isSurprise: true, status: 'address_confirmed' }),
      ).toBe(true);
    });
    it('masks at default_address_used', () => {
      expect(
        shouldMaskGiftBody({
          isSurprise: true,
          status: 'default_address_used',
        }),
      ).toBe(true);
    });
    it('masks at preparing', () => {
      expect(
        shouldMaskGiftBody({ isSurprise: true, status: 'preparing' }),
      ).toBe(true);
    });
    it('masks at shipped', () => {
      // The user has the package en-route but hasn't seen it yet.
      // Mask the product until physical delivery resolves the
      // surprise.
      expect(shouldMaskGiftBody({ isSurprise: true, status: 'shipped' })).toBe(
        true,
      );
    });
    it('masks at cancelled (surprise never resolved)', () => {
      // A surprise that gets cancelled NEVER resolves. The
      // receiver never sees the product, and we never leak it
      // via the cancellation notification body.
      expect(
        shouldMaskGiftBody({ isSurprise: true, status: 'cancelled' }),
      ).toBe(true);
    });
    it('does NOT mask at delivered (reveal point)', () => {
      // Delivery is the only canonical state where the surprise
      // resolves — the receiver has the package physically.
      expect(
        shouldMaskGiftBody({ isSurprise: true, status: 'delivered' }),
      ).toBe(false);
    });
  });
});

describe('bodyForReceiverGiftUpdate', () => {
  it('returns the candidate body when no mask applies', () => {
    expect(
      bodyForReceiverGiftUpdate(
        { isSurprise: false, status: 'preparing' },
        'Eau de Parfum — Dior',
      ),
    ).toBe('Eau de Parfum — Dior');
  });

  it('returns null when the mask applies (surprise + pre-delivery)', () => {
    expect(
      bodyForReceiverGiftUpdate(
        { isSurprise: true, status: 'shipped' },
        'Eau de Parfum — Dior',
      ),
    ).toBeNull();
  });

  it('returns the body at delivery even on surprise gifts', () => {
    expect(
      bodyForReceiverGiftUpdate(
        { isSurprise: true, status: 'delivered' },
        'Eau de Parfum — Dior',
      ),
    ).toBe('Eau de Parfum — Dior');
  });

  it('passes null candidate through unchanged', () => {
    // Some producers already pass null (e.g. address-confirm). The
    // helper should not invent a body for them.
    expect(
      bodyForReceiverGiftUpdate(
        { isSurprise: false, status: 'pending_address' },
        null,
      ),
    ).toBeNull();
  });
});
