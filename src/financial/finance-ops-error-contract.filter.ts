// FINANCE OPS ERROR CONTRACT — HTTP boundary filter (founder closure
// task, 2026-07-23). Registered on AdminController only.
//
// Three behaviors, nothing else:
//   1. An escaped IllegalExecutionBinding (§33/§34 violation, today a
//      500) becomes the canonical 409 business conflict — EXCEPT
//      replay_not_verified, which stays a sanitized 500 (P0 integrity
//      alarm; logged + Sentry-captured, body carries no detail).
//   2. An HttpException whose machine-code message is governed by the
//      contract re-emits with the canonical 409 body
//      { statusCode, error, message, code, reason }.
//   3. Everything else passes through byte-compatible with Nest's
//      default rendering: HttpExceptions keep their status and body
//      (machine-code messages gain a `code` echo so clients can
//      always read `code`); non-HTTP errors render Nest's fixed
//      sanitized 500 body. No stack traces, no internal ids, no
//      financial metadata — ever.
//
// NO financial semantics live here: refusal CONDITIONS stay in the
// services; this filter only shapes the HTTP response of refusals
// that already happened. It performs NO writes (a refusal mutates
// nothing) and never triggers a retry.

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import { IllegalExecutionBinding } from '../settlement/settlement-execution-binding';
import {
  isMachineCode,
  mapBindingViolation,
  mapRefusalMessage,
  stableCodeEcho,
} from './finance-ops-error-contract';

const SANITIZED_500 = {
  statusCode: 500,
  message: 'Internal server error',
} as const;

@Catch()
export class FinanceOpsErrorContractFilter implements ExceptionFilter {
  private readonly logger = new Logger(FinanceOpsErrorContractFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    // 1 — §33/§34 binding violations.
    if (exception instanceof IllegalExecutionBinding) {
      const mapped = mapBindingViolation(exception);
      if (mapped) {
        // A §33/§34 violation ATTEMPT is refused as 409 but stays
        // OBSERVABLE: it never loses its server-side trail (abuse
        // probing must not become invisible just because the client
        // now gets a tidy conflict).
        this.logger.warn(
          `binding violation refused (409 ${mapped.code}): ${mapped.reason}`,
        );
        Sentry.captureMessage(
          `finance_ops_binding_refusal:${mapped.reason}`,
          'warning',
        );
        return res.status(mapped.statusCode).json(mapped);
      }
      // Alarm class (replay_not_verified / unknown sub-reason): the
      // detail goes to the log and Sentry, NEVER the body.
      this.logger.error(
        `P0 integrity alarm (sanitized 500): ${String(exception.message)}`,
      );
      Sentry.captureException(exception);
      return res.status(500).json(SANITIZED_500);
    }

    // 2/3 — HttpExceptions: canonical re-emit or faithful pass-through.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as Record<string, unknown>)?.message ?? null);

      const mapped = mapRefusalMessage(message);
      if (mapped) {
        return res.status(mapped.statusCode).json(mapped);
      }

      // Pass-through. Machine-code messages gain a `code` echo — the
      // STABLE BASE only, never a dynamic ':' suffix — so the client
      // contract ("read `code`") holds uniformly; prose bodies
      // (guards, validators) are untouched.
      if (typeof body === 'string') {
        return res.status(status).json(
          isMachineCode(body)
            ? {
                statusCode: status,
                message: body,
                code: stableCodeEcho(body),
              }
            : { statusCode: status, message: body },
        );
      }
      const obj = body as Record<string, unknown>;
      if (isMachineCode(obj?.message) && obj.code === undefined) {
        return res
          .status(status)
          .json({ ...obj, code: stableCodeEcho(obj.message) });
      }
      return res.status(status).json(obj);
    }

    // Genuinely unexpected: Nest's fixed sanitized body. The real
    // error goes to the log and Sentry only.
    this.logger.error(
      exception instanceof Error
        ? (exception.stack ?? exception.message)
        : String(exception),
    );
    Sentry.captureException(exception);
    return res.status(500).json(SANITIZED_500);
  }
}
