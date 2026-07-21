// Settlement Clock (Track C permanent implementation rule 2).
//
// The Settlement Engine must NEVER read system time directly — replay
// (SC v2.0 §34) and tests demand determinism. Time enters the engine
// ONLY through this injectable abstraction; SystemSettlementClock is
// the single sanctioned place where the settlement subsystem touches
// the system clock. Tests and the future §34 replay harness inject
// fixed clocks.
//
// Pinned by settlement-rules.spec.ts: governed settlement sources
// contain zero direct system-time reads; this file exactly one.
import { Injectable } from '@nestjs/common';

export const SETTLEMENT_CLOCK = 'SETTLEMENT_CLOCK';

export interface SettlementClock {
  now(): Date;
}

@Injectable()
export class SystemSettlementClock implements SettlementClock {
  now(): Date {
    return new Date();
  }
}
