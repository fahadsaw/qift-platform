import { Prisma } from '@prisma/client';
import { convertDecimals } from './decimal-to-number.interceptor';

describe('DecimalToNumberInterceptor (FIN-3 wire-format guarantee)', () => {
  it('converts a real Prisma.Decimal to a plain JSON number', () => {
    const out = convertDecimals(new Prisma.Decimal('172.5'));
    expect(out).toBe(172.5);
    expect(typeof out).toBe('number');
  });

  it('converts Decimals nested in invoice-shaped payloads', () => {
    const invoice = {
      id: 'inv-1',
      status: 'issued',
      totalAmount: new Prisma.Decimal('172.50'),
      vatRate: new Prisma.Decimal('0.1500'),
      taxSnapshot: { vatAmount: new Prisma.Decimal('22.5') },
      issuedAt: new Date('2026-07-04T10:00:00Z'),
      metadata: null,
    };
    const out = convertDecimals(invoice) as unknown as {
      totalAmount: number;
      vatRate: number;
      taxSnapshot: { vatAmount: number };
    };
    expect(out.totalAmount).toBe(172.5);
    expect(out.vatRate).toBe(0.15);
    expect(out.taxSnapshot.vatAmount).toBe(22.5);
    // JSON.stringify of the converted payload carries NUMBERS, not the
    // strings Prisma.Decimal would serialize to — the API contract every
    // frontend consumes is unchanged.
    expect(JSON.stringify(out)).toContain('"totalAmount":172.5');
    expect(JSON.stringify(out)).not.toContain('"totalAmount":"172.5"');
  });

  it('converts Decimals inside arrays (list endpoints)', () => {
    const out = convertDecimals([
      { amount: new Prisma.Decimal('5750') },
      { amount: new Prisma.Decimal('0.01') },
    ]) as Array<{ amount: number }>;
    expect(out[0].amount).toBe(5750);
    expect(out[1].amount).toBe(0.01);
  });

  it('leaves non-Decimal values untouched', () => {
    const date = new Date('2026-07-04T10:00:00Z');
    const payload = {
      str: 'hello',
      num: 42,
      bool: true,
      nul: null,
      date,
      arr: [1, 'two'],
    };
    const out = convertDecimals(payload) as typeof payload;
    expect(out.str).toBe('hello');
    expect(out.num).toBe(42);
    expect(out.bool).toBe(true);
    expect(out.nul).toBeNull();
    expect(out.date).toBe(date); // same instance — not rebuilt
    expect(out.arr).toEqual([1, 'two']);
  });

  it('passes primitives and undefined through', () => {
    expect(convertDecimals(undefined)).toBeUndefined();
    expect(convertDecimals(null)).toBeNull();
    expect(convertDecimals('x')).toBe('x');
    expect(convertDecimals(7)).toBe(7);
  });
});
