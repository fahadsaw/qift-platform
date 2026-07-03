// DecimalToNumberInterceptor (FIN-3) — the wire-format guarantee.
//
// FIN-3 converted the financial-record columns (FinancialLedgerEntry,
// CorporateInvoice, MerchantInvoice) from Float to exact NUMERIC, which
// makes Prisma return Prisma.Decimal objects — and JSON.stringify
// serializes a Decimal as a STRING ("172.5"), silently changing the API
// contract every frontend consumes. This global interceptor converts
// every Decimal in every response back to a plain JSON number, so the
// wire format is byte-identical to the pre-FIN-3 API.
//
// Money amounts are ≤ NUMERIC(12,2) — far inside Number's safe range,
// so the conversion is lossless. Registered once via APP_INTERCEPTOR in
// AppModule (not main.ts) so it also applies to e2e-booted apps.
//
// The walk is defensive: Dates, strings, numbers, booleans, null and
// plain arrays/objects pass through untouched; only Decimal-like
// objects (Prisma.Decimal instances) are converted. Cycles cannot occur
// in Prisma results / DTOs we return.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Observable, map } from 'rxjs';

function convertDecimals(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Prisma.Decimal.isDecimal(value)) {
    return (value as Prisma.Decimal).toNumber();
  }
  if (Array.isArray(value)) {
    return value.map(convertDecimals);
  }
  // Plain object — rebuild with converted values. Class instances
  // (DTOs) are treated as plain bags of properties, which is exactly
  // what JSON.stringify would do anyway.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = convertDecimals(v);
  }
  return out;
}

@Injectable()
export class DecimalToNumberInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map(convertDecimals));
  }
}

// Exported for unit tests.
export { convertDecimals };
