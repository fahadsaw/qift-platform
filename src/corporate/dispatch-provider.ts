// Dispatch provider lane (Corporate Foundation PR 4).
//
// The seam between the dispatch worker and ANY outbound delivery
// channel, per the external-integrations rule: every external API
// is reached through a Qift-owned interface, never directly.
//
// THE MVP NEVER AUTO-SENDS. The invitation architecture (manual-
// share MVP) forbids Qift-initiated SMS / email / social DMs until
// provider contracts + compliance review + feature flags exist.
// ManualDispatchProvider is therefore the ONLY registered provider:
// it performs no outbound call — processing a job through it means
// "the claim artifact is ready for manual distribution" (concierge
// pilot: ops exports the list; the company distributes internally).
//
// Future SmsDispatchProvider / EmailDispatchProvider implement this
// same interface behind QIFT_DISPATCH_PROVIDER + compliance gates —
// the worker does not change.

export type DispatchDelivery = {
  jobId: string;
  campaignId: string;
  contactId: string;
  // The recipient's channel, read LIVE from CorporateContact at
  // processing time (never persisted on the job).
  channel: 'phone' | 'email';
  channelValue: string;
  // PR 5 seam: the claim URL once the claim flow mints tokens.
  claimUrl: string | null;
};

export type DispatchResult =
  | { ok: true }
  | { ok: false; error: string; permanent?: boolean };

export interface DispatchProvider {
  readonly name: string;
  deliver(delivery: DispatchDelivery): Promise<DispatchResult>;
}

// Nest DI token — CorporateModule binds it to ManualDispatchProvider.
export const DISPATCH_PROVIDER = 'qift:dispatch-provider';

export class ManualDispatchProvider implements DispatchProvider {
  readonly name = 'manual';

  // No outbound call by design (manual-share MVP). The job ledger +
  // claimRef IS the deliverable: ops cuts the distribution list
  // from it.
  deliver(): Promise<DispatchResult> {
    return Promise.resolve({ ok: true });
  }
}
