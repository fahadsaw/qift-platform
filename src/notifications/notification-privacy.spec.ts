// Unit specs for the notification-producer privacy helper.
//
// Single rule: surprise gifts mask `productName` + similar
// product-revealing strings in receiver-facing notification
// bodies UNTIL the gift reaches `delivered`. Sender-side
// notifications never mask (the sender chose the product).

import {
  bodyForReceiverGiftUpdate,
  senderDisplayForReceiverGiftNotification,
  shouldMaskGiftBody,
  shouldMaskGiftSender,
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

// =====================================================================
// Week 2 — Anonymous-sender masking.
//
// Single rule: receiver-facing gift notifications must hide sender
// identity when gift.isAnonymous === true. The helpers here are the
// canonical surface; producers wanting to render "X sent you a gift"
// must thread through senderDisplayForReceiverGiftNotification.
//
// Audit context: at the time of this commit, no receiver-facing
// producer references sender.qiftUsername / sender.fullName in any
// notification title or body. These helpers exist as defense-in-
// depth for future producers (and as a regression-safety net for the
// current ones).
// =====================================================================

describe('shouldMaskGiftSender', () => {
  it('returns true when isAnonymous=true (regardless of sender projection)', () => {
    expect(
      shouldMaskGiftSender({
        isAnonymous: true,
        sender: { qiftUsername: 'reem', fullName: 'Reem' },
      }),
    ).toBe(true);
  });

  it('returns false when isAnonymous=false', () => {
    expect(
      shouldMaskGiftSender({
        isAnonymous: false,
        sender: { qiftUsername: 'reem', fullName: 'Reem' },
      }),
    ).toBe(false);
  });

  it('returns true when isAnonymous=true even with sender=null', () => {
    expect(shouldMaskGiftSender({ isAnonymous: true, sender: null })).toBe(
      true,
    );
  });

  it('returns true when isAnonymous=true even with sender=undefined', () => {
    expect(shouldMaskGiftSender({ isAnonymous: true })).toBe(true);
  });
});

describe('senderDisplayForReceiverGiftNotification', () => {
  describe('anonymous gifts mask the sender (the load-bearing case)', () => {
    it('returns null when isAnonymous=true + fullName + qiftUsername populated', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: true,
          sender: { qiftUsername: 'reem', fullName: 'Reem AlDossari' },
        }),
      ).toBeNull();
    });

    it('returns null when isAnonymous=true + only qiftUsername', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: true,
          sender: { qiftUsername: 'reem', fullName: null },
        }),
      ).toBeNull();
    });

    it('returns null when isAnonymous=true + sender entirely missing', () => {
      expect(
        senderDisplayForReceiverGiftNotification({ isAnonymous: true }),
      ).toBeNull();
    });
  });

  describe('non-anonymous gifts surface sender identity', () => {
    it('returns fullName when available', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: false,
          sender: { qiftUsername: 'reem', fullName: 'Reem AlDossari' },
        }),
      ).toBe('Reem AlDossari');
    });

    it('returns trimmed fullName (incidental whitespace)', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: false,
          sender: { qiftUsername: 'reem', fullName: '  Reem  ' },
        }),
      ).toBe('Reem');
    });

    it('falls back to @qiftUsername when fullName is null', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: false,
          sender: { qiftUsername: 'reem', fullName: null },
        }),
      ).toBe('@reem');
    });

    it('falls back to @qiftUsername when fullName is empty string', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: false,
          sender: { qiftUsername: 'reem', fullName: '' },
        }),
      ).toBe('@reem');
    });
  });

  describe('defensive null path (sender projection missing)', () => {
    it('returns null when isAnonymous=false but sender row is null', () => {
      // Should never happen in well-formed flows — defense in depth.
      // The producer that hits this path sees `null`, the same
      // sentinel as anonymous, and renders the generic variant
      // rather than leaking a partial / wrong identity.
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: false,
          sender: null,
        }),
      ).toBeNull();
    });

    it('returns null when sender exists but both name fields are missing', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: false,
          sender: { qiftUsername: null, fullName: null },
        }),
      ).toBeNull();
    });

    it('returns null when sender exists but qiftUsername is empty', () => {
      expect(
        senderDisplayForReceiverGiftNotification({
          isAnonymous: false,
          sender: { qiftUsername: '', fullName: null },
        }),
      ).toBeNull();
    });
  });

  describe('contract: structural subtype accepted', () => {
    it('accepts a richer Gift shape without an explicit cast', () => {
      // Confirms the AnonAwareGift type is structurally permissive —
      // producers can pass their full Prisma-row shape (with extra
      // fields like productName, status, sender.id, etc.) without
      // a cast or projection step.
      const fullGift = {
        id: 'gift-1',
        senderId: 'sender-1',
        receiverId: 'receiver-1',
        productName: 'باقة جوري',
        storeName: 'باقات الرياض',
        status: 'pending_address',
        isAnonymous: true,
        isSurprise: false,
        sender: {
          id: 'sender-1',
          qiftUsername: 'reem',
          fullName: 'Reem',
        },
      };
      expect(senderDisplayForReceiverGiftNotification(fullGift)).toBeNull();
    });
  });
});
