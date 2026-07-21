// Settlement lifecycle state law (Track C PR 1).
//
// Settlement Constitution v2.0 §2, verbatim as code: two grains (item,
// batch), enumerated states, LEGAL transitions only. No state is ever
// skipped silently; terminal states never transition; the engine
// asserts every move through these tables — a transition not listed
// here throws, it does not "work anyway".

export const ITEM_STATES = [
  'pending',
  'eligible',
  'held',
  'ready',
  'settled',
  'reversed',
  'disputed',
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const BATCH_STATES = [
  'ready',
  'failed',
  'held',
  'settled',
  'superseded',
] as const;
export type BatchState = (typeof BATCH_STATES)[number];

// SC §2 item rows. `reversed` is reachable only from settled (the
// post-settlement clawback flow, §8/§9 — arrives with the receipts
// PR); `disputed` freezes from any pre-settled state.
const ITEM_TRANSITIONS: Record<ItemState, readonly ItemState[]> = {
  pending: ['eligible', 'held', 'disputed'],
  eligible: ['ready', 'held', 'disputed'],
  held: ['eligible', 'disputed'],
  ready: ['settled', 'eligible', 'held', 'disputed'],
  settled: ['reversed'],
  reversed: [],
  disputed: ['eligible', 'held'],
};

// SC §2 batch rows, verbatim: settled and superseded are TERMINAL
// (v2.0 state law); failed retries under the SAME QS (ready),
// escalates to held ("repeated failure → investigation", §2/§19.2),
// or supersedes; a held batch resolves to ready or supersedes.
// RECORDED INTERPRETATION (review finding 12): Failed and Held are
// exercised at BATCH grain here — items inside a failed/held batch
// stay 'ready' (bound) through retry/investigation; if the outcome
// changes composition, that is supersession, which re-disposes items.
const BATCH_TRANSITIONS: Record<BatchState, readonly BatchState[]> = {
  ready: ['settled', 'failed', 'superseded'],
  failed: ['ready', 'held', 'superseded'],
  held: ['ready', 'superseded'],
  settled: [],
  superseded: [],
};

export class IllegalSettlementTransition extends Error {
  constructor(grain: 'item' | 'batch', from: string, to: string) {
    super(`illegal_settlement_transition:${grain}:${from}->${to}`);
  }
}

export function assertItemTransition(from: ItemState, to: ItemState): void {
  if (!ITEM_TRANSITIONS[from]?.includes(to)) {
    throw new IllegalSettlementTransition('item', from, to);
  }
}

export function assertBatchTransition(from: BatchState, to: BatchState): void {
  if (!BATCH_TRANSITIONS[from]?.includes(to)) {
    throw new IllegalSettlementTransition('batch', from, to);
  }
}
