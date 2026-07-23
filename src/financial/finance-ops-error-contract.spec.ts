// FINANCE OPS ERROR CONTRACT — pins (founder closure task).
//
// Proves the stable HTTP contract for every refusal class the Finance
// Ops Console consumes:
//   - every known refusal → the correct status + canonical `code`
//     (with the specific legacy string preserved as `reason`);
//   - §33/§34 binding violations are 409 business conflicts, EXCEPT
//     replay_not_verified which stays a sanitized 500;
//   - authorization stays 403 and prose bodies pass through untouched;
//   - malformed input stays 400; not-found stays 404;
//   - genuinely unexpected errors stay 500 with Nest's fixed body —
//     no stack traces, no internal ids, no financial metadata;
//   - the filter itself performs NO writes (a refusal mutates
//     nothing at this layer by construction).

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { IllegalExecutionBinding } from '../settlement/settlement-execution-binding';
import {
  BINDING_TO_CANONICAL,
  CANONICAL,
  FINANCE_OPS_ERROR_CONTRACT_VERSION,
  LEGACY_TO_CANONICAL,
  isMachineCode,
  mapBindingViolation,
  mapRefusalMessage,
} from './finance-ops-error-contract';
import { FinanceOpsErrorContractFilter } from './finance-ops-error-contract.filter';

// ── Harness: capture what the filter writes to the response ────────
function run(exception: unknown) {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  type MockRes = {
    status: (code: number) => MockRes;
    json: (body: Record<string, unknown>) => MockRes;
  };
  const res: MockRes = {
    status(code: number): MockRes {
      out.status = code;
      return res;
    },
    json(body: Record<string, unknown>): MockRes {
      out.body = body;
      return res;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new FinanceOpsErrorContractFilter().catch(exception, host);
  return out as { status: number; body: Record<string, unknown> };
}

describe('finance ops error contract (finops-errors@v1)', () => {
  it('pins the contract version', () => {
    expect(FINANCE_OPS_ERROR_CONTRACT_VERSION).toBe('finops-errors@v1');
  });

  // ── 1. Canonical mapping table — every entry, exhaustively ───────
  it('every governed legacy refusal maps to 409 with its canonical code and preserved reason', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL)) {
      const mapped = mapRefusalMessage(legacy)!;
      expect(mapped).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: canonical,
        message: canonical,
        reason: legacy,
      });
    }
  });

  it('dynamic-suffix refusals match on the base and preserve the full reason', () => {
    const mapped = mapRefusalMessage('preview_requires_ready:failed')!;
    expect(mapped.code).toBe(CANONICAL.BATCH_STATE_CONFLICT);
    expect(mapped.reason).toBe('preview_requires_ready:failed');
    expect(mapped.statusCode).toBe(409);
  });

  it('ungoverned machine codes and prose are left alone by the mapper', () => {
    expect(mapRefusalMessage('treasury_notes_required')).toBeNull();
    expect(mapRefusalMessage('internal_transfer_evidence_reused')).toBeNull();
    expect(
      mapRefusalMessage('Operation requires elevated permissions'),
    ).toBeNull();
    expect(mapRefusalMessage(42)).toBeNull();
    expect(mapRefusalMessage(undefined)).toBeNull();
  });

  // ── 2. Binding violations (§33/§34) ──────────────────────────────
  it('every recoverable binding violation maps to its canonical 409', () => {
    for (const [sub, canonical] of Object.entries(BINDING_TO_CANONICAL)) {
      const mapped = mapBindingViolation(new IllegalExecutionBinding(sub))!;
      expect(mapped).toMatchObject({
        statusCode: 409,
        code: canonical,
        reason: `illegal_execution_binding:${sub}`,
      });
    }
    // The founder's named separations, explicitly:
    expect(
      mapBindingViolation(
        new IllegalExecutionBinding('executor_cannot_approve'),
      )!.code,
    ).toBe(CANONICAL.EXECUTOR_IS_FINAL_APPROVER);
    expect(
      mapBindingViolation(new IllegalExecutionBinding('approval_required'))!
        .code,
    ).toBe(CANONICAL.APPROVAL_MISSING);
  });

  it('replay_not_verified is the P0 alarm: NOT mapped — it stays a sanitized 500', () => {
    expect(
      mapBindingViolation(new IllegalExecutionBinding('replay_not_verified')),
    ).toBeNull();
    const { status, body } = run(
      new IllegalExecutionBinding('replay_not_verified'),
    );
    expect(status).toBe(500);
    expect(body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  // ── 3. Filter end-to-end shapes ──────────────────────────────────
  it('executor-in-approvers surfaces as 409 settlement_executor_is_final_approver (was a 500)', () => {
    const { status, body } = run(
      new IllegalExecutionBinding('executor_cannot_approve'),
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: CANONICAL.EXECUTOR_IS_FINAL_APPROVER,
      code: CANONICAL.EXECUTOR_IS_FINAL_APPROVER,
      reason: 'illegal_execution_binding:executor_cannot_approve',
    });
  });

  it.each([
    ['preview_hash_mismatch', 409, CANONICAL.CALC_HASH_MISMATCH],
    ['approval_snapshot_stale', 409, CANONICAL.CALC_HASH_MISMATCH],
    ['preview_act_required', 409, CANONICAL.PREVIEW_STALE],
    ['insufficient_approvals', 409, CANONICAL.APPROVAL_MISSING],
    ['settlement_approval_expired', 409, CANONICAL.APPROVAL_EXPIRED],
    ['approver_cannot_be_proposer', 409, CANONICAL.APPROVER_IS_PROPOSER],
    [
      'treasury_attester_cannot_resolve',
      409,
      CANONICAL.ATTESTER_CANNOT_RESOLVE,
    ],
    ['financial_gates_not_attested', 409, CANONICAL.GATES_NOT_ATTESTED],
    ['settlement_already_remitted', 409, CANONICAL.BATCH_STATE_CONFLICT],
    ['zero_net_close_requires_exact_zero', 409, CANONICAL.BATCH_STATE_CONFLICT],
  ])('%s → %i %s', (legacy, status, code) => {
    const out = run(new ConflictException(legacy));
    expect(out.status).toBe(status);
    expect(out.body.code).toBe(code);
    expect(out.body.reason).toBe(legacy);
  });

  it('state-fact refusals thrown as 400 today are corrected to 409 at the boundary', () => {
    const { status, body } = run(
      new BadRequestException('execution_use_zero_net_close'),
    );
    expect(status).toBe(409);
    expect(body.code).toBe(CANONICAL.BATCH_STATE_CONFLICT);
    expect(body.reason).toBe('execution_use_zero_net_close');
  });

  it('missing permission stays 403 with the prose body untouched (no code injected)', () => {
    const { status, body } = run(
      new ForbiddenException('Operation requires elevated permissions'),
    );
    expect(status).toBe(403);
    expect(body.message).toBe('Operation requires elevated permissions');
    expect(body.code).toBeUndefined();
  });

  it('malformed input stays 400 and gains a code echo of its stable string', () => {
    const { status, body } = run(
      new BadRequestException('treasury_notes_required'),
    );
    expect(status).toBe(400);
    expect(body.message).toBe('treasury_notes_required');
    expect(body.code).toBe('treasury_notes_required');
  });

  it('tenant-scoped not-found stays 404 with its stable code', () => {
    const { status, body } = run(new NotFoundException('invoice_not_found'));
    expect(status).toBe(404);
    expect(body.code).toBe('invoice_not_found');
    const b = run(new NotFoundException('settlement_batch_not_found'));
    expect(b.status).toBe(404);
    expect(b.body.code).toBe('settlement_batch_not_found');
  });

  it('ungoverned business conflicts pass through as 409 with their own stable code', () => {
    const { status, body } = run(
      new ConflictException('internal_transfer_evidence_reused'),
    );
    expect(status).toBe(409);
    expect(body.code).toBe('internal_transfer_evidence_reused');
  });

  // ── 4. Unexpected errors: sanitized 500, nothing leaks ───────────
  it('a plain Error stays 500 with the fixed body — no message, stack, or ids leak', () => {
    const boom = new Error('secret-internal-detail id=cmr123 iban=SA44');
    const { status, body } = run(boom);
    expect(status).toBe(500);
    expect(body).toEqual({ statusCode: 500, message: 'Internal server error' });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('cmr123');
    expect(serialized).not.toContain('SA44');
    expect(serialized).not.toContain('at '); // no stack frames
  });

  // ── 5. The filter performs no writes (refusals mutate nothing) ───
  it('the filter has no persistence dependencies — refusal shaping cannot mutate state', () => {
    const filter = new FinanceOpsErrorContractFilter() as unknown as Record<
      string,
      unknown
    >;
    // No prisma/ledger/audit handles exist on the filter; its only
    // collaborator is the response object it writes the body to.
    expect(filter.prisma).toBeUndefined();
    expect(filter.ledger).toBeUndefined();
    expect(filter.audit).toBeUndefined();
  });

  it('isMachineCode separates stable codes from prose', () => {
    expect(isMachineCode('settlement_preview_stale')).toBe(true);
    expect(isMachineCode('preview_requires_ready:failed')).toBe(true);
    expect(isMachineCode('Operation requires elevated permissions')).toBe(
      false,
    );
    expect(isMachineCode('')).toBe(false);
  });
});
