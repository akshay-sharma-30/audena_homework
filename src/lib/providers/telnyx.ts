// Telnyx adapter.
//
// Outbound: pretends to be the Telnyx Call Control API. Returns a
// `call_control_id` (`v3:<base64>`) and schedules JSON-envelope webhooks
// to `/api/webhooks/telnyx`. The shape is fundamentally different from
// Twilio:
//
//   { data: { event_type, payload: { call_control_id, state, ... } } }
//
// Event types fire as the call progresses (`call.initiated`, `call.ringing`,
// `call.answered`, `call.machine.detection.ended`, `call.hangup`) — most
// don't change our internal status, which is fine; the webhook handler
// short-circuits same-state events as no-ops.
//
// Inbound: `parseTelnyxWebhook(body)` returns a NormalizedEvent. Mapping is
// driven primarily by `event_type` and, for the terminal `call.hangup`
// event, the `hangup_cause` field.

import { randomBytes } from "crypto";
import type { AnsweredBy, CallStatus } from "@/lib/types";
import { rollOutcome, schedule } from "./simulation";
import { signTelnyx } from "./signing";
import type { CallProvider, NormalizedEvent, PlaceCallResult } from "./types";

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const WEBHOOK_URL = `${PUBLIC_BASE_URL}/api/webhooks/telnyx`;

// Telnyx `event_type` → our internal `CallStatus`.
// `call.hangup` is special-cased below because it needs `hangup_cause`.
const EVENT_STATUS_MAP: Record<string, CallStatus | undefined> = {
  "call.initiated": "dialing",
  "call.ringing": "dialing",
  "call.answered": "in_progress",
};

// Telnyx `hangup_cause` → our internal `CallStatus`. Vocabulary is wildly
// different from Twilio (normal_clearing vs completed, user_busy vs busy)
// — exactly the kind of detail you have to know per-provider.
const HANGUP_CAUSE_MAP: Record<string, CallStatus> = {
  normal_clearing: "completed",
  user_busy: "busy",
  no_answer: "no_answer",
  call_rejected: "failed",
  invalid_number: "failed",
  carrier_failure: "failed",
};

// Telnyx AMD `result` → our internal `AnsweredBy`. Telnyx distinguishes
// `machine` (no beep detected yet) from `answering_machine` (beep detected,
// safe to leave a message).
const AMD_RESULT_MAP: Record<string, AnsweredBy> = {
  machine: "machine",
  answering_machine: "machine_end_beep",
};

function callControlId(): string {
  return "v3:" + randomBytes(18).toString("base64url");
}

type TelnyxEnvelope = {
  data: {
    event_type: string;
    occurred_at: string;
    payload: Record<string, unknown>;
  };
};

async function postTelnyxWebhook(envelope: TelnyxEnvelope): Promise<void> {
  // Sign the EXACT bytes we send — re-stringifying would produce different
  // whitespace and break verification. JSON.stringify once; sign once; send.
  const rawBody = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signTelnyx(timestamp, rawBody);
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Telnyx-Signature-Ed25519": signature,
        "Telnyx-Timestamp": timestamp,
      },
      body: rawBody,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[telnyx] webhook delivery failed", err);
  }
}

function envelope(
  eventType: string,
  payload: Record<string, unknown>
): TelnyxEnvelope {
  return {
    data: {
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      payload,
    },
  };
}

export class TelnyxProvider implements CallProvider {
  readonly name = "telnyx" as const;

  placeCall(): PlaceCallResult {
    const call_control_id = callControlId();
    const outcome = rollOutcome();

    // Telnyx fires many events per call. We only schedule the ones that
    // change our internal state — duplicates would be 200-acked as
    // same-state no-ops anyway, but no point sending them.
    schedule(200, () =>
      void postTelnyxWebhook(envelope("call.initiated", { call_control_id }))
    );

    switch (outcome.kind) {
      case "human": {
        // Real Telnyx with AMD enabled: detection event fires *before*
        // call.answered (or in place of it for the status-update purpose).
        // We emit AMD with result=human so `answeredBy: "human"` is
        // persisted — required for the UI's "→ Agent" KPI to count the call.
        schedule(outcome.pickupAtMs, () =>
          void postTelnyxWebhook(
            envelope("call.machine.detection.ended", {
              call_control_id,
              result: "human",
            })
          )
        );
        schedule(outcome.completeAtMs, () =>
          void postTelnyxWebhook(
            envelope("call.hangup", {
              call_control_id,
              hangup_cause: "normal_clearing",
              call_duration_secs: Math.round(
                (outcome.completeAtMs - outcome.pickupAtMs) / 1000
              ),
            })
          )
        );
        break;
      }
      case "voicemail": {
        // Telnyx fires call.machine.detection.ended with the AMD result,
        // then call.hangup. We emit just the AMD event — the parser maps it
        // directly to our terminal `voicemail` status.
        schedule(outcome.detectedAtMs, () =>
          void postTelnyxWebhook(
            envelope("call.machine.detection.ended", {
              call_control_id,
              result: outcome.beep ? "answering_machine" : "machine",
            })
          )
        );
        break;
      }
      case "no_answer": {
        schedule(outcome.ringoutAtMs, () =>
          void postTelnyxWebhook(
            envelope("call.hangup", {
              call_control_id,
              hangup_cause: "no_answer",
            })
          )
        );
        break;
      }
      case "busy": {
        schedule(outcome.detectedAtMs, () =>
          void postTelnyxWebhook(
            envelope("call.hangup", {
              call_control_id,
              hangup_cause: "user_busy",
            })
          )
        );
        break;
      }
      case "carrier_failure": {
        schedule(outcome.failureAtMs, () =>
          void postTelnyxWebhook(
            envelope("call.hangup", {
              call_control_id,
              hangup_cause:
                outcome.reason === "invalid_number"
                  ? "invalid_number"
                  : "carrier_failure",
            })
          )
        );
        break;
      }
    }

    return { providerCallId: call_control_id };
  }
}

type TelnyxBody = {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      hangup_cause?: string;
      result?: string;
    };
  };
};

/**
 * Parse a Telnyx webhook JSON envelope into our normalized event shape.
 * Returns `null` for events we don't act on (the bulk of Telnyx's traffic —
 * `call.bridged`, `call.recording.saved`, etc. — gets dropped here without
 * an error so the producer doesn't retry).
 */
export function parseTelnyxWebhook(body: unknown): NormalizedEvent | null {
  const env = body as TelnyxBody;
  const eventType = env?.data?.event_type;
  const payload = env?.data?.payload;
  if (!eventType || !payload) return null;
  const providerCallId = payload.call_control_id;
  if (!providerCallId) return null;

  if (eventType === "call.hangup") {
    const cause = payload.hangup_cause ?? "normal_clearing";
    const status = HANGUP_CAUSE_MAP[cause] ?? "completed";
    return { providerCallId, status };
  }

  if (eventType === "call.machine.detection.ended") {
    const result = payload.result;
    if (!result) return null;
    if (result === "human") {
      // Telnyx can also report human via AMD; surface as in_progress with
      // explicit AnsweredBy so analytics still see "human" as the answerer.
      return { providerCallId, status: "in_progress", answeredBy: "human" };
    }
    const answeredBy = AMD_RESULT_MAP[result];
    if (!answeredBy) return null; // e.g., "not_sure" — drop, retry won't help
    return { providerCallId, status: "voicemail", answeredBy };
  }

  const mapped = EVENT_STATUS_MAP[eventType];
  if (!mapped) return null;
  return { providerCallId, status: mapped };
}
