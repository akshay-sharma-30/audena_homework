// Twilio adapter.
//
// Outbound: pretends to be `twilio.calls.create(...)`. Returns a CallSid
// (Twilio's id format: `CA<32hex>`) and schedules status callbacks back to
// `/api/webhooks/twilio`. The webhook body is `application/x-www-form-
// urlencoded` (not JSON — that's a real Twilio quirk people miss), keyed by
// `CallSid`, `CallStatus`, `AnsweredBy`, `CallDuration`. Header:
// `X-Twilio-Signature` (in production: HMAC-SHA1 over URL + sorted form
// params; here: a stand-in static check, see lib/auth.ts).
//
// Inbound: `parseTwilioWebhook(form)` returns a NormalizedEvent the shared
// `applyCallEvent()` consumes. Provider-specific status vocabulary is
// translated by a small lookup table — that's where real integration scar
// tissue lives (Twilio's `no-answer` becomes our `no_answer`, etc.).

import { randomBytes } from "crypto";
import type { AnsweredBy, CallStatus } from "@/lib/types";
import { rollOutcome, schedule } from "./simulation";
import { signTwilio } from "./signing";
import type { CallProvider, NormalizedEvent, PlaceCallResult } from "./types";

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
const WEBHOOK_URL = `${PUBLIC_BASE_URL}/api/webhooks/twilio`;

// Twilio's `CallStatus` → our internal `CallStatus`. The named-different
// pairs (in-progress vs in_progress, no-answer vs no_answer) are exactly
// where bugs creep in if you skip the normalization layer.
const STATUS_MAP: Record<string, CallStatus | undefined> = {
  queued: "pending",
  initiated: "dialing",
  ringing: "dialing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "failed",
};

// Twilio's `AnsweredBy` enum (with AMD enabled) is richer than ours; we
// collapse the machine-* variants into our two AMD buckets.
const ANSWERED_BY_MAP: Record<string, AnsweredBy> = {
  human: "human",
  machine_start: "machine",
  machine_end_beep: "machine_end_beep",
  machine_end_silence: "machine",
  machine_end_other: "machine",
  fax: "machine",
  unknown: "machine",
};

function callSid(): string {
  // CA + 32 hex chars. Matches the real format closely enough that anyone
  // who's seen a Twilio dashboard recognises it.
  return "CA" + randomBytes(16).toString("hex");
}

type TwilioWebhookBody = Record<string, string>;

async function postTwilioWebhook(body: TwilioWebhookBody): Promise<void> {
  const form = new URLSearchParams(body).toString();
  // Real Twilio HMAC-SHA1 — `signing.ts` matches the algorithm exactly so
  // pointing this at a real Twilio account is a single constructor change
  // (swap the in-process keypair for the account's auth token).
  const signature = signTwilio(WEBHOOK_URL, body);
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        // Real Twilio: application/x-www-form-urlencoded — NOT JSON. Tests
        // that assume JSON break the moment you point them at a real Twilio
        // account.
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: form,
    });
  } catch (err) {
    // A real provider would retry with exponential backoff.
    // eslint-disable-next-line no-console
    console.error("[twilio] webhook delivery failed", err);
  }
}

export class TwilioProvider implements CallProvider {
  readonly name = "twilio" as const;

  placeCall(): PlaceCallResult {
    const CallSid = callSid();
    const outcome = rollOutcome();

    // Every call gets a ringing event ~200ms after we "hand off."
    schedule(200, () =>
      void postTwilioWebhook({ CallSid, CallStatus: "ringing" })
    );

    switch (outcome.kind) {
      case "human": {
        schedule(outcome.pickupAtMs, () =>
          void postTwilioWebhook({
            CallSid,
            CallStatus: "in-progress",
            AnsweredBy: "human",
          })
        );
        schedule(outcome.completeAtMs, () =>
          void postTwilioWebhook({
            CallSid,
            CallStatus: "completed",
            CallDuration: Math.round(
              (outcome.completeAtMs - outcome.pickupAtMs) / 1000
            ).toString(),
          })
        );
        break;
      }
      case "voicemail": {
        // Twilio behavior with MachineDetection=Enable: status fires as
        // in-progress with AnsweredBy=machine_*, then immediately completed.
        // We emit one event — the parser maps machine_* AnsweredBy on
        // in-progress directly to voicemail (no double event).
        schedule(outcome.detectedAtMs, () =>
          void postTwilioWebhook({
            CallSid,
            CallStatus: "in-progress",
            AnsweredBy: outcome.beep ? "machine_end_beep" : "machine_end_silence",
          })
        );
        break;
      }
      case "no_answer": {
        schedule(outcome.ringoutAtMs, () =>
          void postTwilioWebhook({ CallSid, CallStatus: "no-answer" })
        );
        break;
      }
      case "busy": {
        schedule(outcome.detectedAtMs, () =>
          void postTwilioWebhook({ CallSid, CallStatus: "busy" })
        );
        break;
      }
      case "carrier_failure": {
        schedule(outcome.failureAtMs, () =>
          void postTwilioWebhook({
            CallSid,
            CallStatus: "failed",
            ErrorCode: outcome.reason,
          })
        );
        break;
      }
    }

    return { providerCallId: CallSid };
  }
}

/**
 * Parse a Twilio webhook form body into our normalized event shape.
 * Returns `null` for events we can't or shouldn't act on — the caller
 * 200-acks those (Twilio retries on non-2xx, so we never 4xx a malformed
 * event from the producer side).
 */
export function parseTwilioWebhook(form: FormData): NormalizedEvent | null {
  const providerCallId = form.get("CallSid")?.toString();
  const rawStatus = form.get("CallStatus")?.toString();
  if (!providerCallId || !rawStatus) return null;

  const baseStatus = STATUS_MAP[rawStatus];
  if (!baseStatus) return null;

  const rawAnsweredBy = form.get("AnsweredBy")?.toString();
  const errorCode = form.get("ErrorCode")?.toString();

  // The Twilio AMD quirk: an in-progress event with AnsweredBy=machine_* is
  // *the* signal that this is a voicemail. Normalize to our terminal
  // `voicemail` status so the state machine can drop the call without ever
  // engaging the agent.
  if (rawAnsweredBy && ANSWERED_BY_MAP[rawAnsweredBy]) {
    const answeredBy = ANSWERED_BY_MAP[rawAnsweredBy];
    if (answeredBy !== "human" && baseStatus === "in_progress") {
      return { providerCallId, status: "voicemail", answeredBy };
    }
    return { providerCallId, status: baseStatus, answeredBy };
  }

  if (baseStatus === "failed" && errorCode) {
    return { providerCallId, status: baseStatus, errorMessage: errorCode };
  }

  return { providerCallId, status: baseStatus };
}
