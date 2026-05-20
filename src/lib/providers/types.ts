// Provider abstraction — the shape every telephony adapter must satisfy.
//
// At JT-Aptask the equivalent is `app_api/src/services/calls/CallService.ts`
// (factory) + `providers/{Twilio,Telnyx}Service.ts` (per-provider). Here we
// keep the same shape so swapping the simulator out for the real SDKs is a
// constructor change rather than a rewrite.

import type { AnsweredBy, CallStatus } from "@/lib/types";

export type PlaceCallResult = {
  /** The provider's own id format. Twilio: `CA<32hex>` (CallSid). Telnyx: `v3:<base64>`. */
  providerCallId: string;
};

/**
 * The normalized event each provider's webhook parser emits after stripping
 * away the provider-specific envelope. `lib/call-state.ts` only sees this
 * shape — that's the abstraction win: the state machine, the DB write, and
 * the agent-pool release have zero knowledge of which provider produced the
 * event.
 */
export type NormalizedEvent = {
  providerCallId: string;
  status: CallStatus;
  answeredBy?: AnsweredBy;
  errorMessage?: string;
};

export type ProviderName = "twilio" | "telnyx";

export interface CallProvider {
  readonly name: ProviderName;
  /**
   * Hand a call off to the provider. Returns synchronously with the
   * provider's id; webhooks arrive asynchronously at `/api/webhooks/{name}`.
   */
  placeCall(): PlaceCallResult;
}
